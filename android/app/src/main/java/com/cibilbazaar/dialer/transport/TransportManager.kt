package com.cibilbazaar.dialer.transport

import android.util.Log
import com.cibilbazaar.dialer.protocol.Envelope
import com.cibilbazaar.dialer.protocol.RECONNECT_BACKOFF_MS
import kotlinx.coroutines.*

enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING }

/**
 * CibilBazaar Dialer — Transport Manager (Android side).
 * Mirrors desktop/src/main/transportManager.ts: owns USB/Bluetooth/WiFi,
 * exposes one unified connection, priority USB > BLUETOOTH > WIFI, with
 * exponential-backoff auto-reconnect.
 */
class TransportManager(
    private val usb: UsbTransport,
    private val bluetooth: BluetoothTransport,
    private val wifi: WifiTransport
) {
    private val priority = listOf("USB", "BLUETOOTH", "WIFI")
    private val transports: Map<String, Transport> = mapOf(
        "USB" to usb,
        "BLUETOOTH" to bluetooth,
        "WIFI" to wifi
    )

    private var active: String? = null
    private var lastSuccessful: String? = null
    private var state = ConnectionState.DISCONNECTED
    private var reconnectAttempt = 0
    private var stopped = false
    private var reconnectJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var stateHandler: ((ConnectionState, String?) -> Unit)? = null
    private var messageHandler: ((Envelope) -> Unit)? = null

    init {
        for (name in priority) {
            transports.getValue(name).setOnMessage { env -> messageHandler?.invoke(env) }
            transports.getValue(name).setOnStatusChange { connected -> handleStatus(name, connected) }
        }
    }

    fun onStateChange(handler: (ConnectionState, String?) -> Unit) {
        stateHandler = handler
    }

    fun onMessage(handler: (Envelope) -> Unit) {
        messageHandler = handler
    }

    fun start() {
        stopped = false
        reconnectAttempt = 0
        scope.launch { attemptConnect() }
    }

    fun stop() {
        stopped = true
        reconnectJob?.cancel()
        for (name in priority) transports.getValue(name).disconnect()
        setState(ConnectionState.DISCONNECTED, null)
    }

    private fun orderedCandidates(): List<String> {
        val ls = lastSuccessful ?: return priority
        return listOf(ls) + priority.filter { it != ls }
    }

    private suspend fun attemptConnect() {
        if (stopped) return
        setState(if (reconnectAttempt > 0) ConnectionState.RECONNECTING else ConnectionState.CONNECTING, null)

        for (name in orderedCandidates()) {
            try {
                transports.getValue(name).connect()
                if (name != "WIFI") {
                    activate(name)
                    return
                }
                // WiFi keeps listening; real activation happens via handleStatus
                // once the desktop's TCP client actually connects.
            } catch (e: Exception) {
                Log.w("TransportManager", "$name connect failed: ${e.message}")
            }
        }
        scheduleRetry()
    }

    private fun activate(name: String) {
        active = name
        lastSuccessful = name
        reconnectAttempt = 0
        reconnectJob?.cancel()
        setState(ConnectionState.CONNECTED, name)
        Log.i("TransportManager", "Active transport = $name")
    }

    private fun handleStatus(name: String, connected: Boolean) {
        if (connected) {
            if (active == null || priority.indexOf(name) < priority.indexOf(active)) {
                activate(name)
            }
            return
        }
        if (active == name) {
            active = null
            setState(ConnectionState.RECONNECTING, null)
            scheduleRetry()
        }
    }

    private fun scheduleRetry() {
        if (stopped || reconnectJob?.isActive == true) return
        val delayMs = RECONNECT_BACKOFF_MS[minOf(reconnectAttempt, RECONNECT_BACKOFF_MS.size - 1)]
        reconnectAttempt++
        Log.i("TransportManager", "Retrying in ${delayMs}ms (attempt $reconnectAttempt)")
        reconnectJob = scope.launch {
            delay(delayMs)
            attemptConnect()
        }
    }

    private fun setState(newState: ConnectionState, activeName: String?) {
        state = newState
        stateHandler?.invoke(newState, activeName)
    }

    fun getState() = state to active

    fun isConnected(): Boolean = active != null && transports.getValue(active!!).isConnected()

    fun send(envelope: Envelope) {
        val a = active ?: run {
            Log.w("TransportManager", "Dropped message, no active transport (type=${envelope.type})")
            return
        }
        transports.getValue(a).send(envelope)
    }
}
