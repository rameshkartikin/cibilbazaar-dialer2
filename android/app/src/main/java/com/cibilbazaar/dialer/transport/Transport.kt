package com.cibilbazaar.dialer.transport

import com.cibilbazaar.dialer.protocol.Envelope

/**
 * Common interface every transport (WiFi/Bluetooth/USB) implements so the
 * rest of the app never needs to know which one is active. Mirrors the
 * `Transport` interface in desktop/src/shared/protocol.ts.
 */
interface Transport {
    val name: String // "WIFI" | "BLUETOOTH" | "USB"
    fun isConnected(): Boolean
    suspend fun connect()
    fun disconnect()
    fun send(envelope: Envelope)
    fun setOnMessage(handler: (Envelope) -> Unit)
    fun setOnStatusChange(handler: (Boolean) -> Unit)
}
