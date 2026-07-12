package com.cibilbazaar.dialer.transport

import android.content.Context
import android.hardware.usb.UsbAccessory
import android.hardware.usb.UsbManager
import android.os.ParcelFileDescriptor
import android.util.Log
import com.cibilbazaar.dialer.protocol.*
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * CibilBazaar Dialer — USB transport (Android side, Android Open Accessory).
 * Desktop exposes itself as a USB accessory (manufacturer "CibilBazaar",
 * model "Dialer" — see res/xml/accessory_filter.xml) over the same cable
 * used for charging/data. Android opens the accessory file descriptor and
 * streams the same line-JSON protocol as the other two transports.
 */
class UsbTransport(private val context: Context) : Transport {

    override val name = "USB"

    private val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private var accessory: UsbAccessory? = null
    private var fileDescriptor: ParcelFileDescriptor? = null
    private var inputStream: FileInputStream? = null
    private var outputStream: FileOutputStream? = null
    private val decoder = LineFrameDecoder()
    private var connected = false
    private var messageHandler: ((Envelope) -> Unit)? = null
    private var statusHandler: ((Boolean) -> Unit)? = null
    private var heartbeatJob: Job? = null
    private var readJob: Job? = null
    private var lastActivity = 0L
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override suspend fun connect() {
        withContext(Dispatchers.IO) {
            val accessories = usbManager.accessoryList
            val acc = accessories?.firstOrNull()
                ?: throw Exception("No USB accessory detected. Connect the CibilBazaar Dialer cable.")

            if (!usbManager.hasPermission(acc)) {
                throw Exception("USB permission not granted. Approve the USB access prompt and retry.")
            }

            accessory = acc
            fileDescriptor = usbManager.openAccessory(acc)
                ?: throw Exception("Failed to open USB accessory file descriptor.")
            val fd = fileDescriptor!!.fileDescriptor
            inputStream = FileInputStream(fd)
            outputStream = FileOutputStream(fd)
            lastActivity = System.currentTimeMillis()

            startReadLoop()
            startHeartbeat()
            setConnected(true)
        }
    }

    private fun startReadLoop() {
        readJob = scope.launch {
            val buf = ByteArray(4096)
            try {
                while (isActive) {
                    val n = inputStream?.read(buf) ?: -1
                    if (n < 0) break
                    lastActivity = System.currentTimeMillis()
                    val chunk = String(buf, 0, n, Charsets.UTF_8)
                    for (env in decoder.push(chunk)) dispatch(env)
                }
            } catch (e: Exception) {
                Log.w("UsbTransport", "Read loop ended: ${e.message}")
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
                    Log.w("UsbTransport", "Heartbeat timeout")
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
            outputStream?.write(envelope.encodeLine().toByteArray(Charsets.UTF_8))
            outputStream?.flush()
        } catch (e: Exception) {
            Log.e("UsbTransport", "Write failed: ${e.message}")
        }
    }

    override fun isConnected() = connected

    override fun send(envelope: Envelope) = sendRaw(envelope)

    override fun disconnect() {
        heartbeatJob?.cancel()
        readJob?.cancel()
        try {
            inputStream?.close()
            outputStream?.close()
            fileDescriptor?.close()
        } catch (_: Exception) {
        }
        inputStream = null
        outputStream = null
        fileDescriptor = null
        setConnected(false)
    }

    override fun setOnMessage(handler: (Envelope) -> Unit) {
        messageHandler = handler
    }

    override fun setOnStatusChange(handler: (Boolean) -> Unit) {
        statusHandler = handler
    }
}
