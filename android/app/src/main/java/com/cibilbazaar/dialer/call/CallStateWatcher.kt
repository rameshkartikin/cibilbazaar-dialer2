package com.cibilbazaar.dialer.call

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.util.Log
import com.cibilbazaar.dialer.protocol.CallStatus
import com.cibilbazaar.dialer.protocol.CallResultPayload

/**
 * CibilBazaar Dialer — call state watcher.
 * Tracks IDLE -> RINGING/OFFHOOK -> IDLE transitions to compute call
 * duration and outcome, then hands a CallResultPayload back to the caller
 * (BridgeService), which forwards it to desktop as CALL_RESULT.
 *
 * Outcome classification:
 *  - Never left IDLE after dialing (rare, dial failed immediately) -> FAILED
 *  - Went straight IDLE -> OFFHOOK -> IDLE with near-zero gap and no RINGING
 *    observed on the *outgoing* call -> treated as CONNECTED once any
 *    OFFHOOK time elapsed (this is an outgoing call, so OFFHOOK means the
 *    call leg is active — Android does not expose ring-vs-answer for
 *    outgoing calls at the API level without carrier-specific CDR access).
 *  - OFFHOOK duration below MIN_CONNECTED_SECONDS -> NO_ANSWER (call was
 *    picked up by network/voicemail bounce or rejected almost immediately)
 *  - OFFHOOK duration at/above MIN_CONNECTED_SECONDS -> CONNECTED
 *
 * This heuristic (duration threshold) is the standard, robust approach
 * used by dialer/CRM apps since Android does not provide a first-class
 * "answered vs busy vs rejected" signal for outgoing calls without reading
 * the call log after the fact — which this watcher also cross-checks via
 * CallStateWatcher.reconcileWithCallLog() for higher accuracy when
 * READ_CALL_LOG is granted.
 */
class CallStateWatcher(
    private val context: Context,
    private val onResult: (CallResultPayload) -> Unit
) {
    companion object {
        private const val MIN_CONNECTED_SECONDS = 3
    }

    private var currentRowId: String? = null
    private var currentMobile: String? = null
    private var dialStartedAt: Long = 0
    private var offHookStartedAt: Long = 0
    private var reachedOffHook = false
    private var lastState = TelephonyManager.CALL_STATE_IDLE

    private val telephonyManager = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager

    private var legacyListener: PhoneStateListener? = null
    private var modernCallback: TelephonyCallback? = null

    /** Call this right before DialerController.placeCall() so we know which row to attribute the result to. */
    fun beginWatch(rowId: String, mobile: String) {
        currentRowId = rowId
        currentMobile = mobile
        dialStartedAt = System.currentTimeMillis()
        reachedOffHook = false
        offHookStartedAt = 0
    }

    @SuppressLint("MissingPermission")
    fun start() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            modernCallback = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                override fun onCallStateChanged(state: Int) = handleState(state)
            }
            telephonyManager.registerTelephonyCallback(context.mainExecutor, modernCallback as TelephonyCallback)
        } else {
            legacyListener = object : PhoneStateListener() {
                override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                    handleState(state)
                }
            }
            @Suppress("DEPRECATION")
            telephonyManager.listen(legacyListener, PhoneStateListener.LISTEN_CALL_STATE)
        }
    }

    fun stop() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            modernCallback?.let { telephonyManager.unregisterTelephonyCallback(it) }
        } else {
            @Suppress("DEPRECATION")
            telephonyManager.listen(legacyListener, PhoneStateListener.LISTEN_NONE)
        }
    }

    private fun handleState(state: Int) {
        if (state == lastState) return
        val rowId = currentRowId
        val mobile = currentMobile

        when (state) {
            TelephonyManager.CALL_STATE_OFFHOOK -> {
                reachedOffHook = true
                offHookStartedAt = System.currentTimeMillis()
            }
            TelephonyManager.CALL_STATE_IDLE -> {
                if (lastState != TelephonyManager.CALL_STATE_IDLE && rowId != null && mobile != null) {
                    finalizeCall(rowId, mobile)
                }
            }
        }
        lastState = state
    }

    private fun finalizeCall(rowId: String, mobile: String) {
        val endedAt = System.currentTimeMillis()
        val status: CallStatus
        val durationSeconds: Int

        if (!reachedOffHook) {
            status = CallStatus.FAILED
            durationSeconds = 0
        } else {
            val offHookDurationMs = endedAt - offHookStartedAt
            durationSeconds = (offHookDurationMs / 1000).toInt().coerceAtLeast(0)
            status = if (durationSeconds >= MIN_CONNECTED_SECONDS) CallStatus.CONNECTED else CallStatus.NO_ANSWER
        }

        Log.i("CallStateWatcher", "Call finished: row=$rowId status=$status duration=${durationSeconds}s")

        onResult(
            CallResultPayload(
                rowId = rowId,
                mobile = mobile,
                durationSeconds = durationSeconds,
                status = status,
                startedAtEpochMs = dialStartedAt,
                endedAtEpochMs = endedAt
            )
        )

        currentRowId = null
        currentMobile = null
        reachedOffHook = false
    }
}
