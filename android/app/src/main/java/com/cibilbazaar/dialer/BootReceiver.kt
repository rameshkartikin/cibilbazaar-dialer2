package com.cibilbazaar.dialer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.cibilbazaar.dialer.transport.BridgeService

/**
 * CibilBazaar Dialer — boot receiver.
 * Restarts the bridge service automatically after the phone reboots, so
 * the agent's device is always ready for the desktop to reconnect without
 * needing to manually reopen the app (supports "Automatic Reconnect").
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val serviceIntent = Intent(context, BridgeService::class.java).apply {
                action = BridgeService.ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        }
    }
}
