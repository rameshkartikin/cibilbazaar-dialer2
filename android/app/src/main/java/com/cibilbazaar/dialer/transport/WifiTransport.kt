package com.cibilbazaar.dialer.transport

import android.util.Log
import com.cibilbazaar.dialer.protocol.*
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter
import java.net.*

/**
 * CibilBazaar Dialer — WiFi transport (Android side, TCP client).
 * Discovers the desktop via UDP broadcast on WIFI_DISCOVERY_UDP_PORT, then
 * connects to its TCP server on WIFI_TCP_PORT. Sends the pairing code
 * shown on the desktop's "Device" tab in the HELLO message.
 */
class WifiTransport(
    private val deviceName: String,
    private var pairingCode: String,
    private var manualHost: String? = null
) : Transport {

    override val name = "WIFI"

    private var socket: Socket? = null
    private var writer: PrintWriter? = null
    private var reader: BufferedReader? = null
    private val decoder = LineFrameDecoder()
    private var connected = false
    private var messageHandler: ((Envelope) -> Unit)? = null
    private var statusHandler: ((Boolean) -> Unit)? = null
    private var heartbeatJob: Job? = null
    private var readJob: Job? = null
    private var lastActivity = 0L
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    fun updatePairingCode(code: String) {
        pairingCode = code
    }

    fun updateManualHost(host: String?) {
        manualHost = host
    }

    private suspend fun discoverHost(timeoutMs: Long = 4000): String? = withContext(Dispatchers.IO) {
        if (!manualHost.isNullOrBlank()) return@withContext manualHost

        try {
            DatagramSocket().use { udp ->
                udp.broadcast = true
                udp.soTimeout = timeoutMs.toInt()
                val msg = "CIBILBAZAAR_DISCOVER".toByteArray()
                val packet = DatagramPacket(msg, msg.size, InetAddress.getByName("255.255.255.255"), WIFI_DISCOVERY_UDP_PORT)
                udp.send(packet)

                val buf = ByteArray(1024)
                val response = DatagramPacket(buf, buf.size)
                udp.receive(response)
                val text = String(response.data, 0, response.length)
                val json = JSONObject(text)
                return@withContext json.optString("host", response.address.hostAddress)
            }
        } catch (e: Exception) {
            Log.w("WifiTransport", "Discovery failed: ${e.message}")
            null
        }
    }

    override suspend fun connect() {
        val host = discoverHost() ?: throw Exception("Could not discover CibilBazaar Desktop on the network. Enter IP manually.")
        withContext(Dispatchers.IO) {
            val s = Socket()
            s.connect(InetSocketAddress(host, WIFI_TCP_PORT), 8000)
            socket = s
            writer = PrintWriter(s.getOutputStream(), true)
            reader = BufferedReader(InputStreamReader(s.getInputStream()))
            lastActivity = System.currentTimeMillis()

            sendRaw(Envelope.make(MessageType.HELLO, helloPayload(deviceName, pairingCode)))

            startReadLoop()
            startHeartbeat()
            setConnected(true)
        }
    }

    private fun startReadLoop() {
        readJob = scope.launch {
            try {
                val buf = CharArray(2048)
                while (isActive) {
                    val n = reader?.read(buf) ?: -1
                    if (n < 0) break
                    lastActivity = System.currentTimeMillis()
                    val chunk = String(buf, 0, n)
                    for (env in decoder.push(chunk)) dispatch(env)
                }
            } catch (e: Exception) {
                Log.w("WifiTransport", "Read loop ended: ${e.message}")
            } finally {
                handleDisconnect()
            }
        }
    }

    private fun dispatch(env: Envelope) {
        when (env.type) {
            MessageType.HELLO_ACK -> {
                val accepted = env.payload.optBoolean("accepted", false)
                if (!accepted) {
                    Log.w("WifiTransport", "HELLO rejected: ${env.payload.optString("reason")}")
                    disconnect()
                    return
                }
            }
            MessageType.PING -> sendRaw(Envelope.make(MessageType.PONG, JSONObject()))
            else -> {}
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
                    Log.w("WifiTransport", "Heartbeat timeout, dropping connection")
                    disconnect()
                    break
                }
            }
        }
    }

    private fun handleDisconnect() {
        heartbeatJob?.cancel()
        setConnected(false)
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
            Log.e("WifiTransport", "Write failed: ${e.message}")
        }
    }

    override fun isConnected() = connected

    override fun send(envelope: Envelope) = sendRaw(envelope)

    override fun disconnect() {
        heartbeatJob?.cancel()
        readJob?.cancel()
        try {
            socket?.close()
        } catch (_: Exception) {
        }
        socket = null
        setConnected(false)
    }

    override fun setOnMessage(handler: (Envelope) -> Unit) {
        messageHandler = handler
    }

    override fun setOnStatusChange(handler: (Boolean) -> Unit) {
        statusHandler = handler
    }
}
