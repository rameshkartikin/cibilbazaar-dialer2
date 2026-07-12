/**
 * CibilBazaar Dialer — shared protocol types (see /shared/protocol.md for spec).
 * Mirrors android/app/src/main/java/.../protocol/Protocol.kt exactly.
 */

export type MessageType =
  | "HELLO"
  | "HELLO_ACK"
  | "DIAL_REQUEST"
  | "DIAL_ACK"
  | "CALL_RESULT"
  | "CALL_RESULT_ACK"
  | "SMS_REQUEST"
  | "SMS_ACK"
  | "PING"
  | "PONG"
  | "ERROR";

export interface Envelope<T = unknown> {
  v: 1;
  type: MessageType;
  id: string;
  ts: number;
  payload: T;
}

export interface HelloPayload {
  deviceName: string;
  role: "ANDROID" | "DESKTOP";
  appVersion: string;
  pairingCode?: string;
}

export interface HelloAckPayload {
  accepted: boolean;
  deviceName: string;
  reason?: string;
}

export interface DialRequestPayload {
  rowId: string;
  mobile: string;
  name: string;
}

export interface DialAckPayload {
  rowId: string;
  opened: boolean;
}

export type CallStatus =
  | "CONNECTED"
  | "NO_ANSWER"
  | "BUSY"
  | "FAILED"
  | "REJECTED";

export interface CallResultPayload {
  rowId: string;
  mobile: string;
  durationSeconds: number;
  status: CallStatus;
  startedAtEpochMs: number;
  endedAtEpochMs: number;
}

export interface CallResultAckPayload {
  rowId: string;
  saved: boolean;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface SmsRequestPayload {
  rowId: string;
  mobile: string;
  message?: string; // optional pre-filled body (e.g. a follow-up template)
}

export interface SmsAckPayload {
  rowId: string;
  opened: boolean;
}

export const PROTOCOL_VERSION = 1 as const;
export const BLUETOOTH_SPP_UUID = "94f39d29-7d6d-437d-973b-fba39e49d4ee";
export const WIFI_TCP_PORT = 47521;
export const WIFI_DISCOVERY_UDP_PORT = 47522;
export const HEARTBEAT_INTERVAL_MS = 5000;
export const HEARTBEAT_TIMEOUT_MS = 15000;
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export function makeEnvelope<T>(type: MessageType, payload: T): Envelope<T> {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: cryptoRandomId(),
    ts: Date.now(),
    payload,
  };
}

export function cryptoRandomId(): string {
  // RFC4122-ish v4 without pulling in a dependency
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function encodeLine(envelope: Envelope<unknown>): string {
  return JSON.stringify(envelope) + "\n";
}

/**
 * Incrementally feeds raw bytes/strings from a stream-based transport
 * (Bluetooth RFCOMM / USB serial) and yields complete parsed envelopes as
 * they arrive, since those transports have no built-in message framing.
 */
export class LineFrameDecoder {
  private buffer = "";

  push(chunk: string): Envelope<any>[] {
    this.buffer += chunk;
    const out: Envelope<any>[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // malformed line — drop silently, keeps stream alive
      }
    }
    return out;
  }
}

/**
 * Common interface every transport (WiFi/Bluetooth/USB) implements so the
 * rest of the app (callEngine, UI) never needs to know which one is active.
 */
export interface Transport {
  readonly name: "WIFI" | "BLUETOOTH" | "USB";
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(envelope: Envelope<unknown>): Promise<void>;
  onMessage(handler: (envelope: Envelope<any>) => void): void;
  onStatusChange(handler: (connected: boolean) => void): void;
}
