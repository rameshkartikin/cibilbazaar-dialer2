/**
 * CibilBazaar Dialer — USB transport.
 * Android exposes a USB serial interface (via the app's USB accessory /
 * ADB-forwarded local socket bridged to a virtual COM port — device driver
 * side is standard Android Open Accessory, handled on the Kotlin side in
 * transport/UsbSerialTransport.kt). Desktop just needs a serial port.
 */
import { SerialPort } from "serialport";
import {
  Envelope,
  Transport,
  LineFrameDecoder,
  encodeLine,
  makeEnvelope,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
} from "../shared/protocol";
import { Logger } from "./logger";

const BAUD_RATE = 115200;

export interface UsbTransportOptions {
  logger: Logger;
  /** e.g. "COM5" on Windows. If omitted, connect() auto-detects the first
   * port whose manufacturer string looks like an Android device. */
  portPath?: string;
}

export class UsbTransport implements Transport {
  readonly name = "USB" as const;

  private port: SerialPort | null = null;
  private decoder = new LineFrameDecoder();
  private connected = false;
  private lastActivity = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private messageHandlers: ((envelope: Envelope<any>) => void)[] = [];
  private statusHandlers: ((connected: boolean) => void)[] = [];

  constructor(private opts: UsbTransportOptions) {}

  /** Lists candidate serial ports for the pairing screen's USB device picker. */
  static async listCandidatePorts(): Promise<{ path: string; manufacturer?: string }[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer }));
  }

  private async resolvePortPath(): Promise<string> {
    if (this.opts.portPath) return this.opts.portPath;
    const ports = await SerialPort.list();
    const androidLike = ports.find((p) =>
      /android|samsung|google|xiaomi|oneplus|realme|vivo|oppo/i.test(p.manufacturer ?? "")
    );
    if (!androidLike) {
      throw new Error("No Android USB device detected. Enable USB debugging / File Transfer mode and reconnect the cable.");
    }
    return androidLike.path;
  }

  async connect(): Promise<void> {
    const portPath = await this.resolvePortPath();
    this.port = new SerialPort({ path: portPath, baudRate: BAUD_RATE, autoOpen: false });

    await new Promise<void>((resolve, reject) => {
      this.port!.open((err) => (err ? reject(err) : resolve()));
    });

    this.opts.logger.info(`USB: connected on ${portPath} @ ${BAUD_RATE} baud`);
    this.port.on("data", (chunk: Buffer) => {
      this.lastActivity = Date.now();
      const envelopes = this.decoder.push(chunk.toString("utf8"));
      for (const env of envelopes) this.dispatch(env);
    });
    this.port.on("close", () => this.handleDisconnect());
    this.port.on("error", (err) => {
      this.opts.logger.error(`USB port error: ${err.message}`);
      this.handleDisconnect();
    });

    this.setConnected(true);
    this.startHeartbeat();
  }

  private dispatch(env: Envelope<any>): void {
    if (env.type === "PING") {
      this.sendRaw(makeEnvelope("PONG", {}));
      return;
    }
    for (const h of this.messageHandlers) h(env);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastActivity = Date.now();
    this.heartbeatTimer = setInterval(() => this.sendRaw(makeEnvelope("PING", {})), HEARTBEAT_INTERVAL_MS);
    this.watchdogTimer = setInterval(() => {
      if (this.connected && Date.now() - this.lastActivity > HEARTBEAT_TIMEOUT_MS) {
        this.opts.logger.warn("USB: heartbeat timeout, dropping connection");
        this.port?.close();
      }
    }, 2000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.heartbeatTimer = null;
    this.watchdogTimer = null;
  }

  private handleDisconnect(): void {
    this.stopHeartbeat();
    this.setConnected(false);
  }

  private setConnected(v: boolean): void {
    this.connected = v;
    for (const h of this.statusHandlers) h(v);
  }

  private sendRaw(envelope: Envelope<unknown>): void {
    if (!this.port || !this.port.isOpen) return;
    this.port.write(encodeLine(envelope), (err) => {
      if (err) this.opts.logger.error(`USB write error: ${err.message}`);
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(envelope: Envelope<unknown>): Promise<void> {
    this.sendRaw(envelope);
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    await new Promise<void>((resolve) => {
      if (this.port && this.port.isOpen) this.port.close(() => resolve());
      else resolve();
    });
    this.setConnected(false);
  }

  onMessage(handler: (envelope: Envelope<any>) => void): void {
    this.messageHandlers.push(handler);
  }

  onStatusChange(handler: (connected: boolean) => void): void {
    this.statusHandlers.push(handler);
  }
}
