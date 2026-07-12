package com.cibilbazaar.dialer.ui

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.cibilbazaar.dialer.R
import com.cibilbazaar.dialer.call.DialerController
import com.cibilbazaar.dialer.databinding.ActivityMainBinding
import com.cibilbazaar.dialer.transport.BridgeService
import com.cibilbazaar.dialer.transport.ConnectionState

/**
 * CibilBazaar Dialer — Main activity.
 * Requests all runtime permissions up front, shows live connection status
 * (subscribed from BridgeService's static UI listener), and lets the agent
 * jump to the Pairing screen to set up Bluetooth/USB/WiFi.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        if (results.values.all { it }) {
            startBridgeService()
        } else {
            binding.statusText.text = getString(R.string.permissions_required)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnPairing.setOnClickListener {
            startActivity(Intent(this, PairingActivity::class.java))
        }

        binding.btnRequestPermissions.setOnClickListener {
            requestAllPermissions()
        }

        BridgeService.setUiStateListener { state, active ->
            runOnUiThread { renderConnectionState(state, active) }
        }

        if (hasAllRequiredPermissions()) {
            startBridgeService()
        } else {
            binding.statusText.text = getString(R.string.permissions_required)
        }
    }

    override fun onResume() {
        super.onResume()
        renderConnectionState(BridgeService.lastConnectionState, BridgeService.lastActiveTransport)
    }

    override fun onDestroy() {
        BridgeService.setUiStateListener(null)
        super.onDestroy()
    }

    private fun requiredPermissions(): Array<String> {
        val list = mutableListOf(*DialerController.REQUIRED_PERMISSIONS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            list.add(Manifest.permission.BLUETOOTH_CONNECT)
            list.add(Manifest.permission.BLUETOOTH_SCAN)
            list.add(Manifest.permission.BLUETOOTH_ADVERTISE)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            list.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        return list.toTypedArray()
    }

    private fun hasAllRequiredPermissions(): Boolean =
        requiredPermissions().all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }

    private fun requestAllPermissions() {
        permissionLauncher.launch(requiredPermissions())
    }

    private fun startBridgeService() {
        val intent = Intent(this, BridgeService::class.java).apply { action = BridgeService.ACTION_START }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun renderConnectionState(state: ConnectionState, active: String?) {
        binding.statusText.text = when (state) {
            ConnectionState.CONNECTED -> getString(R.string.status_connected, active)
            ConnectionState.RECONNECTING -> getString(R.string.status_reconnecting)
            ConnectionState.CONNECTING -> getString(R.string.status_connecting)
            ConnectionState.DISCONNECTED -> getString(R.string.status_disconnected)
        }
        binding.statusDot.setBackgroundResource(
            when (state) {
                ConnectionState.CONNECTED -> R.drawable.dot_green
                ConnectionState.RECONNECTING, ConnectionState.CONNECTING -> R.drawable.dot_yellow
                ConnectionState.DISCONNECTED -> R.drawable.dot_red
            }
        )
    }
}
