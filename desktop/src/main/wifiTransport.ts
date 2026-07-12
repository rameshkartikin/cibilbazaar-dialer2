/**
 * CibilBazaar Dialer — WiFi transport (TCP).
 * Desktop listens on WIFI_TCP_PORT and accepts a single active Android
 * connection at a time. Also runs a UDP broadcast responder so the Android
 * app can auto-discover the desktop on the LAN without typing an IP.
 */
import net from "net";
import dgram from "dgram";
import os from "os";
import {
  Envelope,
  Transport,
  LineFrameDecoder,
  encodeLine,
  makeEnvelope,
  WIFI_TCP_PORT,
  WIFI_DISCOVERY_UDP_PORT,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
} from "../shared/protocol";
import { Logger } from "./logger";

export interface WifiTransportOptions {
  pairingCode: string;
  logger: Logger;
}

export class WifiTransport implements Transport {
  readonly name = "WIFI" as const;

  private server: net.Server | null = null;
  private discoverySocket: dgram.Socket | null = null;
  private socket: net.Socket | null = null;
  private decoder = new LineFrameDecoder();
  private connected = false;
  private lastActivity = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private messageHandlers: ((envelope: Envelope<any>) => void)[] = [];
  private statusHandlers: ((connected: boolean) => void)[] = [];

  constructor(private opts: WifiTransportOptions) {}

  async connect(): Promise<void> {
    // "Connect" for the WiFi transport means: start listening for an
    // incoming Android connection (desktop is the server side).
    if (this.server) return;

    this.server = net.createServer((socket) => this.handleIncoming(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(WIFI_TCP_PORT, "0.0.0.0", () => resolve());
    });
    this.opts.logger.info(`WiFi: listening on TCP ${WIFI_TCP_PORT}`);

    this.startDiscoveryResponder();
  }

  private startDiscoveryResponder(): void {
    this.discoverySocket = dgram.createSocket("udp4");
    this.discoverySocket.on("message", (msg, rinfo) => {
      const text = msg.toString("utf8").trim();
      if (text !== "CIBILBAZAAR_DISCOVER") return;
      const reply = Buffer.from(
        JSON.stringify({
          type: "CIBILBAZAAR_DESKTOP",
          host: this.localIpAddress(),
          port: WIFI_TCP_PORT,
          name: os.hostname(),
        })
      );
      this.discoverySocket!.send(reply, rinfo.port, rinfo.address);
    });
    this.discoverySocket.bind(WIFI_DISCOVERY_UDP_PORT, "0.0.0.0", () => {
      this.discoverySocket?.setBroadcast(true);
      this.opts.logger.info(`WiFi: discovery responder on UDP ${WIFI_DISCOVERY_UDP_PORT}`);
    });
  }

  private localIpAddress(): string {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] ?? []) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
    return "127.0.0.1";
  }

  private handleIncoming(socket: net.Socket): void {
    // Only one active Android connection is allowed at a time; reject extras.
    if (this.socket) {
      this.opts.logger.warn("WiFi: rejecting extra incoming connection, one already active");
      socket.destroy();
      return;
    }

    this.socket = socket;
    this.lastActivity = Date.now();
    socket.setEncoding("utf8");

    socket.on("data", (chunk: string) => {
      this.lastActivity = Date.now();
      const envelopes = this.decoder.push(chunk);
      for (const env of envelopes) this.dispatch(env);
    });

    socket.on("close", () => this.handleDisconnect());
    socket.on("error", (err) => {
      this.opts.logger.error(`WiFi socket error: ${err.message}`);
    });

    this.setConnected(true);
    this.startHeartbeat();
  }

  private dispatch(env: Envelope<any>): void {
    if (env.type === "HELLO") {
      const codeOk = env.payload?.pairingCode === this.opts.pairingCode;
      this.sendRaw(
        makeEnvelope("HELLO_ACK", {
          accepted: codeOk,
          deviceName: os.hostname(),
          reason: codeOk ? undefined : "Invalid pairing code",
        })
      );
      if (!codeOk) {
        this.opts.logger.warn("WiFi: HELLO rejected, bad pairing code");
        this.socket?.destroy();
        return;
      }
    }
    if (env.type === "PING") {
      this.sendRaw(makeEnvelope("PONG", {}));
      return;
    }
    for (const h of this.messageHandlers) h(env);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendRaw(makeEnvelope("PING", {}));
    }, HEARTBEAT_INTERVAL_MS);

    this.watchdogTimer = setInterval(() => {
      if (this.connected && Date.now() - this.lastActivity > HEARTBEAT_TIMEOUT_MS) {
        this.opts.logger.warn("WiFi: heartbeat timeout, dropping connection");
        this.socket?.destroy();
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
    this.socket = null;
    this.setConnected(false);
    this.opts.logger.warn("WiFi: Android disconnected, waiting for reconnect");
    // Server keeps listening; Android side is responsible for re-dialing in.
    // No action needed here beyond flipping status — reconnect loop lives in
    // commServer.ts / TransportManager equivalent that owns all 3 transports.
  }

  private setConnected(v: boolean): void {
    this.connected = v;
    for (const h of this.statusHandlers) h(v);
  }

  private sendRaw(envelope: Envelope<unknown>): void {
    if (!this.socket) return;
    this.socket.write(encodeLine(envelope));
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(envelope: Envelope<unknown>): Promise<void> {
    this.sendRaw(envelope);
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
    this.discoverySocket?.close();
    this.discoverySocket = null;
    this.setConnected(false);
  }

  onMessage(handler: (envelope: Envelope<any>) => void): void {
    this.messageHandlers.push(handler);
  }

  onStatusChange(handler: (connected: boolean) => void): void {
    this.statusHandlers.push(handler);
  }
}
