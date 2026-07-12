package com.cibilbazaar.dialer.transport

import android.app.*
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.cibilbazaar.dialer.R
import com.cibilbazaar.dialer.call.CallStateWatcher
import com.cibilbazaar.dialer.call.DialerController
import com.cibilbazaar.dialer.protocol.*
import org.json.JSONObject

/**
 * CibilBazaar Dialer — Bridge Service.
 * The heart of the Android app: runs as a foreground service so the
 * Bluetooth/USB/WiFi connection to desktop survives even when the app is
 * backgrounded. Wires TransportManager <-> DialerController <-> CallStateWatcher:
 *
 *   DIAL_REQUEST (from desktop) -> DialerController.placeCall() -> DIAL_ACK
 *   CallStateWatcher call finished -> CALL_RESULT (to desktop)
 */
class BridgeService : Service() {

    companion object {
        const val CHANNEL_ID = "cibilbazaar_bridge"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "com.cibilbazaar.dialer.action.START"
        const val ACTION_STOP = "com.cibilbazaar.dialer.action.STOP"
        const val PREFS_NAME = "cibilbazaar_prefs"
        const val PREF_PAIRING_CODE = "pairing_code"
        const val PREF_MANUAL_HOST = "manual_host"

        var transportManager: TransportManager? = null
            private set
        var lastConnectionState: ConnectionState = ConnectionState.DISCONNECTED
            private set
        var lastActiveTransport: String? = null
            private set
        private var uiStateListener: ((ConnectionState, String?) -> Unit)? = null

        fun setUiStateListener(listener: ((ConnectionState, String?) -> Unit)?) {
            uiStateListener = listener
        }
    }

    private lateinit var dialerController: DialerController
    private lateinit var callStateWatcher: CallStateWatcher
    private lateinit var prefs: SharedPreferences

    override fun onCreate() {
        super.onCreate()
        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        dialerController = DialerController(this)
        callStateWatcher = CallStateWatcher(this) { result -> handleCallResult(result) }
        callStateWatcher.start()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            else -> startBridge()
        }
        return START_STICKY
    }

    private fun startBridge() {
        startForeground(NOTIFICATION_ID, buildNotification("Waiting for desktop connection..."))

        val bluetoothAdapter = (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
            ?: BluetoothAdapter.getDefaultAdapter()

        val pairingCode = prefs.getString(PREF_PAIRING_CODE, "") ?: ""
        val manualHost = prefs.getString(PREF_MANUAL_HOST, null)

        val usb = UsbTransport(this)
        val bluetooth = BluetoothTransport(bluetoothAdapter)
        val wifi = WifiTransport(deviceName = Build.MODEL ?: "Android Device", pairingCode = pairingCode, manualHost = manualHost)

        val manager = TransportManager(usb, bluetooth, wifi)
        manager.onMessage { env -> handleIncoming(env) }
        manager.onStateChange { state, active ->
            lastConnectionState = state
            lastActiveTransport = active
            uiStateListener?.invoke(state, active)
            updateNotification(state, active)
        }
        transportManager = manager
        manager.start()
    }

    private fun handleIncoming(env: Envelope) {
        when (env.type) {
            MessageType.DIAL_REQUEST -> {
                val payload = DialRequestPayload.fromJson(env.payload)
                callStateWatcher.beginWatch(payload.rowId, payload.mobile)
                val opened = dialerController.placeCall(payload.mobile)
                transportManager?.send(Envelope.make(MessageType.DIAL_ACK, dialAckPayload(payload.rowId, opened)))
            }
            MessageType.SMS_REQUEST -> {
                val payload = SmsRequestPayload.fromJson(env.payload)
                val opened = dialerController.openSms(payload.mobile, payload.message)
                transportManager?.send(Envelope.make(MessageType.SMS_ACK, smsAckPayload(payload.rowId, opened)))
            }
            MessageType.CALL_RESULT_ACK -> {
                // Desktop confirmed it saved the result — nothing further needed.
            }
            else -> {}
        }
    }

    private fun handleCallResult(result: CallResultPayload) {
        transportManager?.send(Envelope.make(MessageType.CALL_RESULT, result.toJson()))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "CibilBazaar Dialer Bridge",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps the connection to CibilBazaar Desktop alive"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CibilBazaar Dialer")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification(state: ConnectionState, active: String?) {
        val text = when (state) {
            ConnectionState.CONNECTED -> "Connected via $active"
            ConnectionState.RECONNECTING -> "Reconnecting..."
            ConnectionState.CONNECTING -> "Connecting..."
            ConnectionState.DISCONNECTED -> "Disconnected"
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    override fun onDestroy() {
        transportManager?.stop()
        transportManager = null
        callStateWatcher.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
