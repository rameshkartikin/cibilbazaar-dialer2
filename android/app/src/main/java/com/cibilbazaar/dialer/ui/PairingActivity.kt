package com.cibilbazaar.dialer.ui

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.widget.ArrayAdapter
import androidx.appcompat.app.AppCompatActivity
import com.cibilbazaar.dialer.databinding.ActivityPairingBinding
import com.cibilbazaar.dialer.transport.BridgeService

/**
 * CibilBazaar Dialer — Pairing activity.
 * Three sections mirroring the desktop's "Device" tab:
 *   1. WiFi — agent types in the 6-digit code shown on desktop (and
 *      optionally the desktop's IP if auto-discovery fails on a locked-down
 *      network).
 *   2. Bluetooth — lists already-OS-paired devices (real pairing/PIN entry
 *      happens in Android's own Bluetooth settings, which this screen deep
 *      links to).
 *   3. USB — requests permission for any attached accessory.
 */
class PairingActivity : AppCompatActivity() {

    private lateinit var binding: ActivityPairingBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPairingBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val prefs = getSharedPreferences(BridgeService.PREFS_NAME, Context.MODE_PRIVATE)
        binding.pairingCodeInput.setText(prefs.getString(BridgeService.PREF_PAIRING_CODE, ""))
        binding.manualHostInput.setText(prefs.getString(BridgeService.PREF_MANUAL_HOST, ""))

        binding.btnSaveWifi.setOnClickListener {
            prefs.edit()
                .putString(BridgeService.PREF_PAIRING_CODE, binding.pairingCodeInput.text.toString().trim())
                .putString(BridgeService.PREF_MANUAL_HOST, binding.manualHostInput.text.toString().trim().ifEmpty { null })
                .apply()
            restartBridge()
        }

        binding.btnOpenBluetoothSettings.setOnClickListener {
            startActivity(Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS))
        }

        binding.btnRefreshPaired.setOnClickListener { loadPairedDevices() }
        binding.btnRequestUsb.setOnClickListener { requestUsbPermission() }

        loadPairedDevices()
    }

    @SuppressLint("MissingPermission")
    private fun loadPairedDevices() {
        val adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
        val names = adapter?.bondedDevices?.map { "${it.name} (${it.address})" } ?: emptyList()
        binding.pairedDevicesList.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, names)
        if (names.isEmpty()) {
            binding.pairedDevicesHint.text = getString(com.cibilbazaar.dialer.R.string.no_paired_devices)
        } else {
            binding.pairedDevicesHint.text = getString(com.cibilbazaar.dialer.R.string.tap_bluetooth_settings_hint)
        }
    }

    private fun requestUsbPermission() {
        val usbManager = getSystemService(Context.USB_SERVICE) as UsbManager
        val accessory = usbManager.accessoryList?.firstOrNull()
        if (accessory == null) {
            binding.usbStatusText.text = getString(com.cibilbazaar.dialer.R.string.no_usb_accessory)
            return
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val permissionIntent = PendingIntent.getBroadcast(this, 0, Intent("com.cibilbazaar.dialer.USB_PERMISSION"), flags)
        usbManager.requestPermission(accessory, permissionIntent)
        binding.usbStatusText.text = getString(com.cibilbazaar.dialer.R.string.usb_permission_requested)
    }

    private fun restartBridge() {
        val intent = Intent(this, BridgeService::class.java).apply { action = BridgeService.ACTION_START }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        finish()
    }
}
