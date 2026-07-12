/**
 * CibilBazaar Dialer — Transport Manager.
 * Owns all three transports (USB, Bluetooth, WiFi) and exposes ONE unified
 * connection to the rest of the app (callEngine, IPC layer). Implements the
 * reconnect + priority rules from /shared/protocol.md section "Reconnect
 * Rules": USB > Bluetooth > WiFi, exponential backoff, auto failover.
 */
import { EventEmitter } from "events";
import { Envelope, Transport, RECONNECT_BACKOFF_MS } from "../shared/protocol";
import { Logger } from "./logger";
import { WifiTransport } from "./wifiTransport";
import { BluetoothTransport } from "./bluetoothTransport";
import { UsbTransport } from "./usbTransport";

export type TransportName = "USB" | "BLUETOOTH" | "WIFI";
export type ConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING";

export interface TransportManagerEvents {
  "state-change": (state: ConnectionState, active: TransportName | null) => void;
  message: (envelope: Envelope<any>) => void;
}

const PRIORITY: TransportName[] = ["USB", "BLUETOOTH", "WIFI"];

export class TransportManager extends EventEmitter {
  private transports: Record<TransportName, Transport>;
  private active: TransportName | null = null;
  private state: ConnectionState = "DISCONNECTED";
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastSuccessful: TransportName | null = null;

  constructor(
    private logger: Logger,
    wifi: WifiTransport,
    bluetooth: BluetoothTransport,
    usb: UsbTransport
  ) {
    super();
    this.transports = { WIFI: wifi, BLUETOOTH: bluetooth, USB: usb };
    for (const name of PRIORITY) {
      this.transports[name].onMessage((env) => this.emit("message", env));
      this.transports[name].onStatusChange((connected) => this.handleTransportStatus(name, connected));
    }
  }

  /** Starts trying to establish a connection, preferring last-successful then priority order. */
  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempt = 0;
    await this.attemptConnect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const name of PRIORITY) this.transports[name].disconnect().catch(() => {});
    this.setState("DISCONNECTED", null);
  }

  private orderedCandidates(): TransportName[] {
    if (!this.lastSuccessful) return PRIORITY;
    return [this.lastSuccessful, ...PRIORITY.filter((p) => p !== this.lastSuccessful)];
  }

  private async attemptConnect(): Promise<void> {
    if (this.stopped) return;
    this.setState(this.reconnectAttempt > 0 ? "RECONNECTING" : "CONNECTING", null);

    for (const name of this.orderedCandidates()) {
      try {
        // WiFi's "connect" is really "start listening" and completes
        // immediately; its actual peer connection arrives asynchronously
        // via handleTransportStatus. For BT/USB, connect() only resolves
        // once a real link is up.
        await this.transports[name].connect();
        if (name !== "WIFI") {
          this.activate(name);
          return;
        }
        // WiFi: keep listening, don't block on other candidates failing —
        // but also try BT/USB in parallel below since WiFi alone doesn't
        // confirm an active peer yet.
      } catch (err: any) {
        this.logger.warn(`TransportManager: ${name} connect failed — ${err.message}`);
      }
    }

    // Nothing confirmed synchronously (BT/USB failed, WiFi just listening).
    // Schedule a backoff retry; if WiFi's peer shows up in the meantime,
    // handleTransportStatus() will cancel this and activate WIFI.
    this.scheduleRetry();
  }

  private activate(name: TransportName): void {
    this.active = name;
    this.lastSuccessful = name;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.setState("CONNECTED", name);
    this.logger.info(`TransportManager: active transport = ${name}`);
  }

  private handleTransportStatus(name: TransportName, connected: boolean): void {
    if (connected) {
      // Respect priority: only switch to a lower-priority transport if
      // nothing higher-priority is currently active.
      if (this.active === null || PRIORITY.indexOf(name) < PRIORITY.indexOf(this.active)) {
        this.activate(name);
      }
      return;
    }

    // A transport dropped.
    if (this.active === name) {
      this.active = null;
      this.setState("RECONNECTING", null);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt++;
    this.logger.info(`TransportManager: retrying in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptConnect();
    }, delay);
  }

  private setState(state: ConnectionState, active: TransportName | null): void {
    this.state = state;
    this.emit("state-change", state, active);
  }

  getState(): { state: ConnectionState; active: TransportName | null } {
    return { state: this.state, active: this.active };
  }

  isConnected(): boolean {
    return this.active !== null && this.transports[this.active].isConnected();
  }

  async send(envelope: Envelope<unknown>): Promise<void> {
    if (!this.active) {
      this.logger.warn(`TransportManager: dropped message, no active transport (type=${envelope.type})`);
      return;
    }
    await this.transports[this.active].send(envelope);
  }

  setBluetoothTarget(address: string): void {
    (this.transports.BLUETOOTH as BluetoothTransport as any).opts.pairedDeviceAddress = address;
  }

  setUsbTarget(portPath: string): void {
    (this.transports.USB as UsbTransport as any).opts.portPath = portPath;
  }
}
