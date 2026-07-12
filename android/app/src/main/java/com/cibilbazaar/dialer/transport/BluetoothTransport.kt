package com.cibilbazaar.dialer.transport

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.util.Log
import com.cibilbazaar.dialer.protocol.*
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter
import java.util.UUID

/**
 * CibilBazaar Dialer — Bluetooth transport (Android side, RFCOMM server).
 * Android listens for the desktop app to connect on the well-known SPP
 * UUID, after standard OS-level Bluetooth pairing has already happened
 * (Android Settings > Bluetooth). That OS pairing step is what provides
 * the "Secure Bluetooth Protocol" requirement — authentication/encryption
 * is handled by the Bluetooth stack itself before our RFCOMM channel ever
 * sees a byte.
 */
class BluetoothTransport(private val adapter: BluetoothAdapter) : Transport {

    override val name = "BLUETOOTH"

    private var serverSocket: BluetoothServerSocket? = null
    private var activeSocket: BluetoothSocket? = null
    private var writer: PrintWriter? = null
    private var reader: BufferedReader? = null
    private val decoder = LineFrameDecoder()
    private var connected = false
    private var messageHandler: ((Envelope) -> Unit)? = null
    private var statusHandler: ((Boolean) -> Unit)? = null
    private var heartbeatJob: Job? = null
    private var acceptJob: Job? = null
    private var readJob: Job? = null
    private var lastActivity = 0L
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @SuppressLint("MissingPermission")
    override suspend fun connect() {
        withContext(Dispatchers.IO) {
            serverSocket = adapter.listenUsingRfcommWithServiceRecord(
                "CibilBazaarDialer",
                UUID.fromString(BLUETOOTH_SPP_UUID)
            )
            acceptJob = scope.launch {
                try {
                    while (isActive) {
                        val socket = serverSocket?.accept() ?: break
                        Log.i("BluetoothTransport", "Accepted connection from ${socket.remoteDevice?.name}")
                        attachSocket(socket)
                    }
                } catch (e: Exception) {
                    Log.w("BluetoothTransport", "Accept loop ended: ${e.message}")
                }
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun attachSocket(socket: BluetoothSocket) {
        // Only one active desktop connection at a time.
        if (activeSocket != null) {
            try {
                socket.close()
            } catch (_: Exception) {
            }
            return
        }
        activeSocket = socket
        writer = PrintWriter(socket.outputStream, true)
        reader = BufferedReader(InputStreamReader(socket.inputStream))
        lastActivity = System.currentTimeMillis()
        setConnected(true)
        startReadLoop()
        startHeartbeat()
    }

    private fun startReadLoop() {
        readJob = scope.launch {
            try {
                val buf = CharArray(2048)
                while (isActive) {
                    val n = reader?.read(buf) ?: -1
                    if (n < 0) break
                    lastActivity = System.currentTimeMillis()
                    for (env in decoder.push(String(buf, 0, n))) dispatch(env)
                }
            } catch (e: Exception) {
                Log.w("BluetoothTransport", "Read loop ended: ${e.message}")
            } finally {
                handleDisconnect()
            }
        }
    }

    private fun dispatch(env: Envelope) {
        if (env.type == MessageType.PING) {
            sendRaw(Envelope.make(MessageType.PONG, JSONObject()))
            return
        }
        messageHandler?.invoke(env)
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                sendRaw(Envelope.make(MessageType.PING, JSONObject()))
                if (System.currentTimeMillis() - lastActivity > HEARTBEAT_TIMEOUT_MS) {
                    Log.w("BluetoothTransport", "Heartbeat timeout")
                    disconnect()
                    break
                }
            }
        }
    }

    private fun handleDisconnect() {
        heartbeatJob?.cancel()
        activeSocket = null
        setConnected(false)
        // Server keeps accepting; desktop is expected to redial per its own
        // reconnect loop (see transportManager.ts RECONNECT_BACKOFF_MS).
    }

    private fun setConnected(v: Boolean) {
        connected = v
        statusHandler?.invoke(v)
    }

    private fun sendRaw(envelope: Envelope) {
        try {
            writer?.print(envelope.encodeLine())
            writer?.flush()
        } catch (e: Exception) {
            Log.e("BluetoothTransport", "Write failed: ${e.message}")
        }
    }

    override fun isConnected() = connected

    override fun send(envelope: Envelope) = sendRaw(envelope)

    @SuppressLint("MissingPermission")
    override fun disconnect() {
        heartbeatJob?.cancel()
        readJob?.cancel()
        acceptJob?.cancel()
        try {
            activeSocket?.close()
        } catch (_: Exception) {
        }
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        activeSocket = null
        serverSocket = null
        setConnected(false)
    }

    override fun setOnMessage(handler: (Envelope) -> Unit) {
        messageHandler = handler
    }

    override fun setOnStatusChange(handler: (Boolean) -> Unit) {
        statusHandler = handler
    }
}
