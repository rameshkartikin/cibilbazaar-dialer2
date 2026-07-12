package com.cibilbazaar.dialer.call

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * CibilBazaar Dialer — Dialer controller.
 * On receiving DIAL_REQUEST from desktop, immediately places the call via
 * ACTION_CALL (auto-dial, no manual tap needed) when CALL_PHONE permission
 * is granted; falls back to ACTION_DIAL (opens dialer pre-filled) if not,
 * so the flow still works, just requires one tap.
 */
class DialerController(private val context: Context) {

    fun hasCallPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED

    /** Returns true if a call intent was successfully fired (auto-dial or dialer-opened). */
    fun placeCall(mobile: String): Boolean {
        val sanitized = mobile.trim()
        if (sanitized.isEmpty()) {
            Log.w("DialerController", "Empty mobile number, ignoring dial request")
            return false
        }
        val uri = Uri.parse("tel:$sanitized")

        return try {
            if (hasCallPermission()) {
                val intent = Intent(Intent.ACTION_CALL, uri).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                context.startActivity(intent)
                Log.i("DialerController", "Auto-dialed $sanitized via ACTION_CALL")
                true
            } else {
                val intent = Intent(Intent.ACTION_DIAL, uri).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                context.startActivity(intent)
                Log.w("DialerController", "CALL_PHONE not granted, opened dialer via ACTION_DIAL instead")
                true
            }
        } catch (e: Exception) {
            Log.e("DialerController", "Failed to place call: ${e.message}")
            false
        }
    }

    /** Opens the system SMS composer pre-filled for this number (and optional message body). */
    fun openSms(mobile: String, message: String? = null): Boolean {
        val sanitized = mobile.trim()
        if (sanitized.isEmpty()) {
            Log.w("DialerController", "Empty mobile number, ignoring SMS request")
            return false
        }
        return try {
            val uri = Uri.parse("smsto:$sanitized")
            val intent = Intent(Intent.ACTION_SENDTO, uri).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
                if (!message.isNullOrEmpty()) putExtra("sms_body", message)
            }
            context.startActivity(intent)
            Log.i("DialerController", "Opened SMS composer for $sanitized")
            true
        } catch (e: Exception) {
            Log.e("DialerController", "Failed to open SMS composer: ${e.message}")
            false
        }
    }

    companion object {
        val REQUIRED_PERMISSIONS = arrayOf(
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.READ_PHONE_NUMBERS
        )

        fun hasAllPermissions(context: Context): Boolean = REQUIRED_PERMISSIONS.all {
            ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
        }
    }
}
