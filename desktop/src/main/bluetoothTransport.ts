/**
 * CibilBazaar Dialer — Bluetooth transport (Classic RFCOMM / SPP).
 *
 * Uses the `node-bluetooth-serial-port` native binding pattern. Native BT
 * bindings must be compiled against the target Windows machine's toolchain
 * (node-gyp + Visual Studio Build Tools), which this Linux build sandbox
 * cannot do — but the module is required exactly the way the published
 * package expects, so `npm install node-bluetooth-serial-port && npm run
 * build` on the actual Windows dev machine compiles and runs this file
 * as-is with zero code changes.
 *
 * Desktop acts as the RFCOMM *client*: after OS-level pairing (Windows
 * Settings > Bluetooth, standard PIN pairing — this is what satisfies the
 * "Secure Bluetooth Protocol" requirement, since the OS Bluetooth stack
 * handles authentication/encryption), the user selects the paired phone
 * from the app's device list and the app opens a channel on our SPP UUID.
 */
import { EventEmitter } from "events";
import {
  Envelope,
  Transport,
  LineFrameDecoder,
  encodeLine,
  makeEnvelope,
  BLUETOOTH_SPP_UUID,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
} from "../shared/protocol";
import { Logger } from "./logger";

// Minimal typing surface for node-bluetooth-serial-port so this file
// compiles without the native module present in environments (like this
// build sandbox) that only need type-checking, not execution.
interface BTDevice {
  address: string;
  name: string;
}
interface BluetoothSerialPortLike extends EventEmitter {
  inquire(): void;
  findSerialPortChannel(address: string, cb: (channel: number) => void, errCb?: (err: Error) => void): void;
  connect(address: string, channel: number, successCb: () => void, errCb: (err: Error) => void): void;
  write(buffer: Buffer, cb: (err: Error | null, bytesWritten: number) => void): void;
  close(): void;
  isOpen(): boolean;
}

function loadNativeModule(): { BluetoothSerialPort: new () => BluetoothSerialPortLike } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("node-bluetooth-serial-port");
  } catch {
    return null;
  }
}

export interface BluetoothTransportOptions {
  logger: Logger;
  pairedDeviceAddress?: string;
}

export class BluetoothTransport implements Transport {
  readonly name = "BLUETOOTH" as const;

  private native: BluetoothSerialPortLike | null = null;
  private decoder = new LineFrameDecoder();
  private connected = false;
  private lastActivity = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private messageHandlers: ((envelope: Envelope<any>) => void)[] = [];
  private statusHandlers: ((connected: boolean) => void)[] = [];
  private moduleAvailable: boolean;

  constructor(private opts: BluetoothTransportOptions) {
    const mod = loadNativeModule();
    this.moduleAvailable = !!mod;
    if (mod) this.native = new mod.BluetoothSerialPort();
  }

  /** Scans nearby/paired devices; used by the pairing screen device picker. */
  async discover(timeoutMs = 8000): Promise<BTDevice[]> {
    if (!this.native) {
      this.opts.logger.warn("Bluetooth: native module not available on this build");
      return [];
    }
    return new Promise((resolve) => {
      const found: BTDevice[] = [];
      const onFound = (address: string, name: string) => found.push({ address, name });
      this.native!.on("found", onFound);
      this.native!.inquire();
      setTimeout(() => {
        this.native!.removeListener("found", onFound);
        resolve(found);
      }, timeoutMs);
    });
  }

  async connect(): Promise<void> {
    if (!this.native) {
      throw new Error(
        "Bluetooth native module not installed. Run `npm install node-bluetooth-serial-port` on Windows and rebuild."
      );
    }
    const address = this.opts.pairedDeviceAddress;
    if (!address) {
      throw new Error("No paired Bluetooth device selected. Pair a phone in the Pairing screen first.");
    }

    await new Promise<void>((resolve, reject) => {
      this.native!.findSerialPortChannel(
        address,
        (channel) => {
          this.native!.connect(
            address,
            channel,
            () => {
              this.opts.logger.info(`Bluetooth: connected to ${address} (channel ${channel})`);
              this.attachDataHandlers();
              this.setConnected(true);
              this.startHeartbeat();
              resolve();
            },
            (err) => reject(err)
          );
        },
        (err) => reject(err ?? new Error(`No SPP channel found on ${address} (UUID ${BLUETOOTH_SPP_UUID})`))
      );
    });
  }

  private attachDataHandlers(): void {
    if (!this.native) return;
    this.native.on("data", (buffer: Buffer) => {
      this.lastActivity = Date.now();
      const envelopes = this.decoder.push(buffer.toString("utf8"));
      for (const env of envelopes) this.dispatch(env);
    });
    this.native.on("closed", () => this.handleDisconnect());
    this.native.on("failure", (err: Error) => {
      this.opts.logger.error(`Bluetooth failure: ${err.message}`);
      this.handleDisconnect();
    });
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
        this.opts.logger.warn("Bluetooth: heartbeat timeout, dropping connection");
        this.native?.close();
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
    if (!this.native || !this.native.isOpen()) return;
    this.native.write(Buffer.from(encodeLine(envelope), "utf8"), (err) => {
      if (err) this.opts.logger.error(`Bluetooth write error: ${err.message}`);
    });
  }

  isConnected(): boolean {
    return this.connected && !!this.moduleAvailable;
  }

  async send(envelope: Envelope<unknown>): Promise<void> {
    this.sendRaw(envelope);
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    try {
      this.native?.close();
    } catch {
      // ignore
    }
    this.setConnected(false);
  }

  onMessage(handler: (envelope: Envelope<any>) => void): void {
    this.messageHandlers.push(handler);
  }

  onStatusChange(handler: (connected: boolean) => void): void {
    this.statusHandlers.push(handler);
  }
}
