/**
 * CibilBazaar Dialer — Call Engine.
 * Drives both single-call and bulk-calling flows: sends DIAL_REQUEST,
 * waits for DIAL_ACK + CALL_RESULT, writes the result to the DB (auto-save),
 * and — in bulk mode — automatically advances to the next PENDING contact.
 */
import { EventEmitter } from "events";
import {
  DialRequestPayload,
  CallResultPayload,
  SmsRequestPayload,
  makeEnvelope,
} from "../shared/protocol";
import { TransportManager } from "./transportManager";
import { DialerDatabase, ContactRow, CallStatusValue } from "./db";
import { Logger } from "./logger";

export type BulkState = "IDLE" | "RUNNING" | "PAUSED" | "STOPPED";

const CALL_RESULT_TIMEOUT_MS = 90_000; // safety timeout if Android never reports back
const GAP_BETWEEN_CALLS_MS = 2_000; // small pause so agent can glance at the previous result

export interface CallEngineEvents {
  "bulk-state-change": (state: BulkState) => void;
  "call-started": (contact: ContactRow) => void;
  "call-finished": (contact: ContactRow, result: CallResultPayload) => void;
  "call-timeout": (contact: ContactRow) => void;
  "queue-progress": (done: number, total: number) => void;
}

export class CallEngine extends EventEmitter {
  private bulkState: BulkState = "IDLE";
  private queue: ContactRow[] = [];
  private queueIndex = 0;
  private currentTimeout: NodeJS.Timeout | null = null;
  private awaitingRowId: string | null = null;
  private autoNextLead = false;

  constructor(
    private db: DialerDatabase,
    private transportManager: TransportManager,
    private logger: Logger,
    private onAutoSave: () => void
  ) {
    super();
    this.transportManager.on("message", (env) => {
      if (env.type === "CALL_RESULT") this.handleCallResult(env.payload as CallResultPayload);
      if (env.type === "DIAL_ACK") this.logger.info(`CallEngine: Android opened dialer for row ${env.payload.rowId}`);
    });
  }

  // ---------- Single call (manual "Call" button) ----------

  async callSingle(rowId: string): Promise<void> {
    const contact = this.db.getContact(rowId);
    if (!contact) throw new Error(`Contact ${rowId} not found`);
    if (!this.transportManager.isConnected()) {
      throw new Error("No device connected. Pair via Bluetooth, USB, or WiFi first.");
    }
    await this.dial(contact);
  }

  setAutoNextLead(enabled: boolean): void {
    this.autoNextLead = enabled;
  }

  getAutoNextLead(): boolean {
    return this.autoNextLead;
  }

  /** Sends an SMS_REQUEST so the paired Android device opens its SMS composer for this number. */
  async sendSms(rowId: string, message?: string): Promise<void> {
    const contact = this.db.getContact(rowId);
    if (!contact) throw new Error(`Contact ${rowId} not found`);
    if (!this.transportManager.isConnected()) {
      throw new Error("No device connected. Pair via Bluetooth, USB, or WiFi first.");
    }
    const payload: SmsRequestPayload = { rowId: contact.id, mobile: contact.mobile, message };
    await this.transportManager.send(makeEnvelope("SMS_REQUEST", payload));
    this.logger.info(`CallEngine: SMS request sent for ${contact.mobile}`);
  }

  /** Finds the next PENDING/NO_ANSWER/BUSY contact after the given row, for Auto Next Lead. */
  private findNextLead(afterRowId: string): ContactRow | undefined {
    const all = this.db.getAllContacts();
    const idx = all.findIndex((c) => c.id === afterRowId);
    const candidates = idx >= 0 ? all.slice(idx + 1) : all;
    return candidates.find((c) => c.status === "PENDING" || c.status === "NO_ANSWER" || c.status === "BUSY");
  }

  private async dial(contact: ContactRow): Promise<void> {
    this.awaitingRowId = contact.id;
    const payload: DialRequestPayload = { rowId: contact.id, mobile: contact.mobile, name: contact.name };
    await this.transportManager.send(makeEnvelope("DIAL_REQUEST", payload));
    this.emit("call-started", contact);
    this.logger.info(`CallEngine: dialing ${contact.mobile} (${contact.name})`);

    if (this.currentTimeout) clearTimeout(this.currentTimeout);
    this.currentTimeout = setTimeout(() => this.handleTimeout(contact), CALL_RESULT_TIMEOUT_MS);
  }

  private handleTimeout(contact: ContactRow): void {
    if (this.awaitingRowId !== contact.id) return;
    this.logger.warn(`CallEngine: timed out waiting for CALL_RESULT on row ${contact.id}`);
    this.emit("call-timeout", contact);
    this.awaitingRowId = null;
    this.advanceBulkIfRunning();
    this.advanceAutoNextIfEnabled(contact.id);
  }

  private handleCallResult(payload: CallResultPayload): void {
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    if (this.awaitingRowId !== payload.rowId) {
      // Late/duplicate result — still persist it, just don't drive bulk flow off it.
      this.logger.warn(`CallEngine: CALL_RESULT for unexpected row ${payload.rowId}`);
    }
    this.awaitingRowId = null;

    const status: CallStatusValue = payload.status;
    const updated = this.db.updateCallResult(payload.rowId, status, payload.durationSeconds);
    this.db.insertCallLog({
      id: cryptoId(),
      contactId: payload.rowId,
      mobile: payload.mobile,
      agent: updated?.agent ?? "",
      status,
      durationSeconds: payload.durationSeconds,
      startedAtEpochMs: payload.startedAtEpochMs,
      endedAtEpochMs: payload.endedAtEpochMs,
    });
    this.onAutoSave();

    if (updated) this.emit("call-finished", updated, payload);
    this.advanceBulkIfRunning();
    this.advanceAutoNextIfEnabled(payload.rowId);
  }

  // ---------- Bulk calling ----------

  startBulk(rowIds?: string[]): void {
    const all = rowIds ? rowIds.map((id) => this.db.getContact(id)).filter(Boolean) as ContactRow[] : this.db.getAllContacts();
    this.queue = all.filter((c) => c.status === "PENDING" || c.status === "NO_ANSWER" || c.status === "BUSY");
    this.queueIndex = 0;
    if (this.queue.length === 0) {
      this.logger.warn("CallEngine: bulk start requested but no eligible (PENDING/NO_ANSWER/BUSY) contacts");
      return;
    }
    this.setBulkState("RUNNING");
    this.emit("queue-progress", 0, this.queue.length);
    this.runNextInQueue();
  }

  pauseBulk(): void {
    if (this.bulkState !== "RUNNING") return;
    this.setBulkState("PAUSED");
    this.logger.info("CallEngine: bulk calling paused");
  }

  resumeBulk(): void {
    if (this.bulkState !== "PAUSED") return;
    this.setBulkState("RUNNING");
    this.logger.info("CallEngine: bulk calling resumed");
    this.runNextInQueue();
  }

  stopBulk(): void {
    this.setBulkState("STOPPED");
    this.queue = [];
    this.queueIndex = 0;
    if (this.currentTimeout) clearTimeout(this.currentTimeout);
    this.awaitingRowId = null;
    this.logger.info("CallEngine: bulk calling stopped");
    this.setBulkState("IDLE");
  }

  private advanceBulkIfRunning(): void {
    if (this.bulkState !== "RUNNING") return;
    setTimeout(() => this.runNextInQueue(), GAP_BETWEEN_CALLS_MS);
  }

  /** Standalone "Auto Next Lead" toggle: outside bulk mode, automatically dials
   *  the next pending lead after each manual call finishes. */
  private advanceAutoNextIfEnabled(justFinishedRowId: string): void {
    if (!this.autoNextLead || this.bulkState === "RUNNING") return;
    const next = this.findNextLead(justFinishedRowId);
    if (!next) {
      this.logger.info("CallEngine: Auto Next Lead — no more pending leads");
      return;
    }
    setTimeout(() => {
      if (!this.autoNextLead) return;
      if (!this.transportManager.isConnected()) {
        this.logger.warn("CallEngine: Auto Next Lead — device disconnected, pausing");
        return;
      }
      this.dial(next).catch((err) => this.logger.error(`Auto Next Lead dial failed: ${err.message}`));
    }, GAP_BETWEEN_CALLS_MS);
  }

  private runNextInQueue(): void {
    if (this.bulkState !== "RUNNING") return;
    if (this.queueIndex >= this.queue.length) {
      this.logger.info("CallEngine: bulk queue complete");
      this.setBulkState("IDLE");
      return;
    }
    const contact = this.queue[this.queueIndex];
    this.queueIndex++;
    this.emit("queue-progress", this.queueIndex, this.queue.length);

    if (!this.transportManager.isConnected()) {
      this.logger.warn("CallEngine: device disconnected mid-bulk-run, pausing until reconnect");
      this.setBulkState("PAUSED");
      this.queueIndex--; // retry same contact once reconnected
      const unsub = () => {
        if (this.transportManager.isConnected() && this.bulkState === "PAUSED") {
          this.resumeBulk();
        }
      };
      this.transportManager.once("state-change", unsub);
      return;
    }

    // Re-fetch fresh row (status may have changed) then dial.
    const fresh = this.db.getContact(contact.id) ?? contact;
    this.dial(fresh);
  }

  getBulkState(): BulkState {
    return this.bulkState;
  }

  private setBulkState(state: BulkState): void {
    this.bulkState = state;
    this.emit("bulk-state-change", state);
  }
}

function cryptoId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
