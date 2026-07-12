# CibilBazaar Dialer — Wire Protocol v1

Transport-agnostic. Same JSON protocol runs over:
- **WiFi**: TCP socket, desktop listens on port `47521`, Android connects (or
  desktop discovers Android via UDP broadcast on `47522` then connects — both
  directions supported for auto-reconnect resilience).
- **Bluetooth**: Classic RFCOMM, well-known SPP UUID
  `94f39d29-7d6d-437d-973b-fba39e49d4ee`. Android runs as `BluetoothServerSocket`,
  Desktop connects as client (or vice versa depending on pairing initiator).
- **USB**: Android in accessory mode / desktop opens serial port at 115200
  baud via `serialport`. Same framing as below.

## Framing
Every message is a single line of UTF-8 JSON terminated by `\n`. No
multi-line JSON allowed (keeps parsing trivial and robust across all three
transports, including byte-stream ones like RFCOMM/serial that have no
built-in message boundaries).

## Message Envelope
```json
{ "v": 1, "type": "MESSAGE_TYPE", "id": "uuid-v4", "ts": 1720000000000, "payload": { } }
```
- `v`: protocol version, always `1`.
- `type`: one of the message types below.
- `id`: unique id for this message, used for ACK correlation.
- `ts`: sender epoch millis.
- `payload`: type-specific body.

## Message Types

### 1. `HELLO` (either side, on connect)
```json
{ "type": "HELLO", "payload": { "deviceName": "Agent-Phone-1", "role": "ANDROID" | "DESKTOP", "appVersion": "1.0.0" } }
```

### 2. `HELLO_ACK`
```json
{ "type": "HELLO_ACK", "payload": { "accepted": true, "deviceName": "CibilBazaar-Desktop" } }
```

### 3. `DIAL_REQUEST` (Desktop → Android)
Sent when agent clicks Call button.
```json
{ "type": "DIAL_REQUEST", "payload": { "rowId": "row_123", "mobile": "9876543210", "name": "Ramesh Kumar" } }
```

### 4. `DIAL_ACK` (Android → Desktop)
Confirms Android opened the system dialer.
```json
{ "type": "DIAL_ACK", "payload": { "rowId": "row_123", "opened": true } }
```

### 5. `CALL_RESULT` (Android → Desktop)
Sent once the call ends (call state goes IDLE after OFFHOOK).
```json
{
  "type": "CALL_RESULT",
  "payload": {
    "rowId": "row_123",
    "mobile": "9876543210",
    "durationSeconds": 42,
    "status": "CONNECTED" | "NO_ANSWER" | "BUSY" | "FAILED" | "REJECTED",
    "startedAtEpochMs": 1720000000000,
    "endedAtEpochMs": 1720000042000
  }
}
```

### 6. `CALL_RESULT_ACK` (Desktop → Android)
```json
{ "type": "CALL_RESULT_ACK", "payload": { "rowId": "row_123", "saved": true } }
```

### 6b. `SMS_REQUEST` (Desktop → Android)
Sent when agent clicks the SMS button. Android opens its SMS composer
pre-filled with the number (and optional message body) — the agent still
taps Send on the phone; this app never sends SMS silently.
```json
{ "type": "SMS_REQUEST", "payload": { "rowId": "row_123", "mobile": "9876543210", "message": "Hi, following up on your loan enquiry." } }
```

### 6c. `SMS_ACK` (Android → Desktop)
```json
{ "type": "SMS_ACK", "payload": { "rowId": "row_123", "opened": true } }
```

### 7. `PING` / `PONG` (both directions, every 5s)
Heartbeat used to detect dead connections and trigger auto-reconnect.
```json
{ "type": "PING", "payload": {} }
{ "type": "PONG", "payload": {} }
```

### 8. `ERROR`
```json
{ "type": "ERROR", "payload": { "code": "DIAL_PERMISSION_DENIED", "message": "CALL_PHONE permission not granted" } }
```

## Reconnect Rules (all transports)
1. Heartbeat: `PING` every 5s. If no `PONG` (or any message) received for
   15s, connection is declared dead.
2. On disconnect, reconnect is attempted with exponential backoff:
   1s, 2s, 4s, 8s, 16s, then capped at 30s, indefinitely, until success or
   user cancels.
3. Transport priority on reconnect attempt: **USB > Bluetooth > WiFi**
   (USB most reliable, then paired Bluetooth, then WiFi LAN). The app tries
   the last-successful transport first, then falls through the priority list.
4. Only one transport is "active" at a time. If a higher-priority transport
   becomes available while a lower one is active, the app switches over
   gracefully (finishes in-flight message, then swaps) without losing state.

## Security
- Bluetooth pairing requires standard OS-level PIN pairing before the app's
  RFCOMM channel will accept a connection (enforced by both OS bluetooth
  stacks).
- WiFi transport requires a shared pairing code: on first connect, Desktop
  shows a 6-digit code; Android must send it in `HELLO.payload.pairingCode`
  matching what Desktop generated, else Desktop replies `HELLO_ACK` with
  `accepted:false` and closes the socket.
- No data ever leaves the local network/device pair — fully offline, no
  cloud relay.
