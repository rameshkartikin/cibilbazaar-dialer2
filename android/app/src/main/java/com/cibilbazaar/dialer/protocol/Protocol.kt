package com.cibilbazaar.dialer.protocol

import org.json.JSONObject
import java.util.UUID

/**
 * CibilBazaar Dialer — wire protocol (see /shared/protocol.md).
 * Mirrors desktop/src/shared/protocol.ts exactly. Manual JSON parsing (no
 * reflection library) keeps this dependency-free and fast on-device.
 */

const val PROTOCOL_VERSION = 1
const val BLUETOOTH_SPP_UUID = "94f39d29-7d6d-437d-973b-fba39e49d4ee"
const val WIFI_TCP_PORT = 47521
const val WIFI_DISCOVERY_UDP_PORT = 47522
const val HEARTBEAT_INTERVAL_MS = 5000L
const val HEARTBEAT_TIMEOUT_MS = 15000L
val RECONNECT_BACKOFF_MS = longArrayOf(1000, 2000, 4000, 8000, 16000, 30000)

enum class MessageType {
    HELLO, HELLO_ACK, DIAL_REQUEST, DIAL_ACK, CALL_RESULT, CALL_RESULT_ACK, SMS_REQUEST, SMS_ACK, PING, PONG, ERROR
}

enum class CallStatus { CONNECTED, NO_ANSWER, BUSY, FAILED, REJECTED }

data class Envelope(
    val v: Int,
    val type: MessageType,
    val id: String,
    val ts: Long,
    val payload: JSONObject
) {
    fun toJson(): JSONObject = JSONObject()
        .put("v", v)
        .put("type", type.name)
        .put("id", id)
        .put("ts", ts)
        .put("payload", payload)

    fun encodeLine(): String = toJson().toString() + "\n"

    companion object {
        fun make(type: MessageType, payload: JSONObject): Envelope =
            Envelope(PROTOCOL_VERSION, type, UUID.randomUUID().toString(), System.currentTimeMillis(), payload)

        fun parse(line: String): Envelope? {
            return try {
                val obj = JSONObject(line)
                Envelope(
                    v = obj.optInt("v", 1),
                    type = MessageType.valueOf(obj.getString("type")),
                    id = obj.getString("id"),
                    ts = obj.optLong("ts", System.currentTimeMillis()),
                    payload = obj.optJSONObject("payload") ?: JSONObject()
                )
            } catch (e: Exception) {
                null // malformed line — drop silently, keep stream alive
            }
        }
    }
}

data class DialRequestPayload(val rowId: String, val mobile: String, val name: String) {
    companion object {
        fun fromJson(json: JSONObject) = DialRequestPayload(
            rowId = json.getString("rowId"),
            mobile = json.getString("mobile"),
            name = json.optString("name", "")
        )
    }
}

data class CallResultPayload(
    val rowId: String,
    val mobile: String,
    val durationSeconds: Int,
    val status: CallStatus,
    val startedAtEpochMs: Long,
    val endedAtEpochMs: Long
) {
    fun toJson(): JSONObject = JSONObject()
        .put("rowId", rowId)
        .put("mobile", mobile)
        .put("durationSeconds", durationSeconds)
        .put("status", status.name)
        .put("startedAtEpochMs", startedAtEpochMs)
        .put("endedAtEpochMs", endedAtEpochMs)
}

fun helloPayload(deviceName: String, pairingCode: String? = null): JSONObject {
    val obj = JSONObject()
        .put("deviceName", deviceName)
        .put("role", "ANDROID")
        .put("appVersion", "1.0.0")
    if (pairingCode != null) obj.put("pairingCode", pairingCode)
    return obj
}

fun dialAckPayload(rowId: String, opened: Boolean): JSONObject =
    JSONObject().put("rowId", rowId).put("opened", opened)

data class SmsRequestPayload(val rowId: String, val mobile: String, val message: String?) {
    companion object {
        fun fromJson(json: JSONObject) = SmsRequestPayload(
            rowId = json.getString("rowId"),
            mobile = json.getString("mobile"),
            message = if (json.has("message") && !json.isNull("message")) json.optString("message") else null
        )
    }
}

fun smsAckPayload(rowId: String, opened: Boolean): JSONObject =
    JSONObject().put("rowId", rowId).put("opened", opened)

/**
 * Incrementally feeds raw text chunks from a stream-based transport
 * (Bluetooth RFCOMM / USB serial) and yields complete parsed envelopes —
 * mirrors LineFrameDecoder in desktop/src/shared/protocol.ts.
 */
class LineFrameDecoder {
    private val buffer = StringBuilder()

    fun push(chunk: String): List<Envelope> {
        buffer.append(chunk)
        val out = mutableListOf<Envelope>()
        var idx: Int
        while (true) {
            idx = buffer.indexOf("\n")
            if (idx < 0) break
            val line = buffer.substring(0, idx).trim()
            buffer.delete(0, idx + 1)
            if (line.isEmpty()) continue
            Envelope.parse(line)?.let { out.add(it) }
        }
        return out
    }
}
