/**
 * CibilBazaar Dialer — SQLite data layer.
 * SQLite mirrors the imported Excel for fast search/filter/history, and is
 * the source that gets written back out to .xlsx on every change (see
 * excelService.ts -> exportToExcel, called by main.ts on a debounce timer).
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { app } from "electron";

export type CallStatusValue =
  | "PENDING"
  | "CONNECTED"
  | "NO_ANSWER"
  | "BUSY"
  | "FAILED"
  | "REJECTED";

export type CallOutcomeValue =
  | ""
  | "INTERESTED"
  | "BUSY"
  | "NO_ANSWER"
  | "CALLBACK"
  | "REJECTED";

export interface ContactRow {
  id: string;
  name: string;
  company: string;
  mobile: string;
  mobileNormalized: string;
  status: CallStatusValue;
  outcome: CallOutcomeValue;
  remarks: string;
  followup: string; // ISO date string, may be empty
  duration: number; // seconds, last call
  agent: string;
  isDuplicate: number; // 0/1
  createdAt: number;
  updatedAt: number;
}

export interface CallLogRow {
  id: string;
  contactId: string;
  mobile: string;
  agent: string;
  status: CallStatusValue;
  durationSeconds: number;
  startedAtEpochMs: number;
  endedAtEpochMs: number;
}

const DB_FILE = "cibilbazaar_dialer.db";

function dbPath(): string {
  const userData = app ? app.getPath("userData") : path.join(process.cwd(), ".data");
  if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
  return path.join(userData, DB_FILE);
}

export class DialerDatabase {
  private db: Database.Database;

  constructor(customPath?: string) {
    this.db = new Database(customPath ?? dbPath());
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        company TEXT NOT NULL DEFAULT '',
        mobile TEXT NOT NULL DEFAULT '',
        mobileNormalized TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'PENDING',
        outcome TEXT NOT NULL DEFAULT '',
        remarks TEXT NOT NULL DEFAULT '',
        followup TEXT NOT NULL DEFAULT '',
        duration INTEGER NOT NULL DEFAULT 0,
        agent TEXT NOT NULL DEFAULT '',
        isDuplicate INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_mobile ON contacts(mobileNormalized);
      CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
      CREATE INDEX IF NOT EXISTS idx_contacts_agent ON contacts(agent);
      CREATE INDEX IF NOT EXISTS idx_contacts_followup ON contacts(followup);

      CREATE TABLE IF NOT EXISTS call_logs (
        id TEXT PRIMARY KEY,
        contactId TEXT NOT NULL,
        mobile TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        durationSeconds INTEGER NOT NULL DEFAULT 0,
        startedAtEpochMs INTEGER NOT NULL,
        endedAtEpochMs INTEGER NOT NULL,
        FOREIGN KEY (contactId) REFERENCES contacts(id)
      );
      CREATE INDEX IF NOT EXISTS idx_calllogs_contact ON call_logs(contactId);
      CREATE INDEX IF NOT EXISTS idx_calllogs_started ON call_logs(startedAtEpochMs);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Safe migration for DBs created before the `outcome` column existed.
    const cols = this.db.prepare(`PRAGMA table_info(contacts)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "outcome")) {
      this.db.exec(`ALTER TABLE contacts ADD COLUMN outcome TEXT NOT NULL DEFAULT ''`);
    }
  }

  // ---------- Contacts ----------

  upsertContact(row: Omit<ContactRow, "createdAt" | "updatedAt" | "mobileNormalized" | "isDuplicate">): ContactRow {
    const now = Date.now();
    const mobileNormalized = normalizeMobile(row.mobile);
    const existing = this.db
      .prepare(`SELECT * FROM contacts WHERE id = ?`)
      .get(row.id) as ContactRow | undefined;

    const isDuplicate = this.countByNormalizedMobile(mobileNormalized, row.id) > 0 ? 1 : 0;

    if (existing) {
      this.db
        .prepare(
          `UPDATE contacts SET name=?, company=?, mobile=?, mobileNormalized=?, status=?, outcome=?, remarks=?, followup=?, duration=?, agent=?, isDuplicate=?, updatedAt=? WHERE id=?`
        )
        .run(
          row.name,
          row.company,
          row.mobile,
          mobileNormalized,
          row.status,
          row.outcome,
          row.remarks,
          row.followup,
          row.duration,
          row.agent,
          isDuplicate,
          now,
          row.id
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO contacts (id, name, company, mobile, mobileNormalized, status, outcome, remarks, followup, duration, agent, isDuplicate, createdAt, updatedAt)
           VALUES (@id,@name,@company,@mobile,@mobileNormalized,@status,@outcome,@remarks,@followup,@duration,@agent,@isDuplicate,@createdAt,@updatedAt)`
        )
        .run({
          ...row,
          mobileNormalized,
          isDuplicate,
          createdAt: now,
          updatedAt: now,
        });
    }
    this.refreshDuplicateFlags(mobileNormalized);
    return this.getContact(row.id)!;
  }

  private countByNormalizedMobile(mobileNormalized: string, excludeId: string): number {
    if (!mobileNormalized) return 0;
    const r = this.db
      .prepare(`SELECT COUNT(*) as c FROM contacts WHERE mobileNormalized = ? AND id != ?`)
      .get(mobileNormalized, excludeId) as { c: number };
    return r.c;
  }

  /** Recomputes isDuplicate for every row sharing this normalized mobile. */
  private refreshDuplicateFlags(mobileNormalized: string): void {
    if (!mobileNormalized) return;
    const rows = this.db
      .prepare(`SELECT id FROM contacts WHERE mobileNormalized = ?`)
      .all(mobileNormalized) as { id: string }[];
    const flag = rows.length > 1 ? 1 : 0;
    for (const r of rows) {
      this.db.prepare(`UPDATE contacts SET isDuplicate=? WHERE id=?`).run(flag, r.id);
    }
  }

  getContact(id: string): ContactRow | undefined {
    return this.db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(id) as ContactRow | undefined;
  }

  getAllContacts(): ContactRow[] {
    return this.db.prepare(`SELECT * FROM contacts ORDER BY createdAt ASC`).all() as ContactRow[];
  }

  searchContacts(query: string, filters: { status?: string; agent?: string; onlyDuplicates?: boolean } = {}): ContactRow[] {
    let sql = `SELECT * FROM contacts WHERE 1=1`;
    const params: unknown[] = [];
    if (query && query.trim()) {
      sql += ` AND (name LIKE ? OR company LIKE ? OR mobile LIKE ? OR remarks LIKE ? OR outcome LIKE ?)`;
      const like = `%${query.trim()}%`;
      params.push(like, like, like, like, like);
    }
    if (filters.status) {
      sql += ` AND status = ?`;
      params.push(filters.status);
    }
    if (filters.agent) {
      sql += ` AND agent = ?`;
      params.push(filters.agent);
    }
    if (filters.onlyDuplicates) {
      sql += ` AND isDuplicate = 1`;
    }
    sql += ` ORDER BY createdAt ASC`;
    return this.db.prepare(sql).all(...params) as ContactRow[];
  }

  updateCallResult(id: string, status: CallStatusValue, durationSeconds: number, remarks?: string): ContactRow | undefined {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE contacts SET status=?, duration=?, remarks=COALESCE(?, remarks), updatedAt=? WHERE id=?`
      )
      .run(status, durationSeconds, remarks ?? null, now, id);
    return this.getContact(id);
  }

  updateField(id: string, field: "remarks" | "followup" | "status" | "agent" | "outcome", value: string): ContactRow | undefined {
    const allowed = new Set(["remarks", "followup", "status", "agent", "outcome"]);
    if (!allowed.has(field)) throw new Error(`Field not editable: ${field}`);
    this.db.prepare(`UPDATE contacts SET ${field}=?, updatedAt=? WHERE id=?`).run(value, Date.now(), id);
    return this.getContact(id);
  }

  /** Follow-ups due today or earlier (and not yet contacted again) — powers the Reminders panel. */
  getDueFollowups(todayIsoDate: string): ContactRow[] {
    return this.db
      .prepare(`SELECT * FROM contacts WHERE followup != '' AND followup <= ? ORDER BY followup ASC`)
      .all(todayIsoDate) as ContactRow[];
  }

  deleteAll(): void {
    this.db.exec(`DELETE FROM contacts; DELETE FROM call_logs;`);
  }

  // ---------- Call Logs ----------

  insertCallLog(row: CallLogRow): void {
    this.db
      .prepare(
        `INSERT INTO call_logs (id, contactId, mobile, agent, status, durationSeconds, startedAtEpochMs, endedAtEpochMs)
         VALUES (@id,@contactId,@mobile,@agent,@status,@durationSeconds,@startedAtEpochMs,@endedAtEpochMs)`
      )
      .run(row);
  }

  getCallHistory(contactId?: string, limit = 500): CallLogRow[] {
    if (contactId) {
      return this.db
        .prepare(`SELECT * FROM call_logs WHERE contactId = ? ORDER BY startedAtEpochMs DESC LIMIT ?`)
        .all(contactId, limit) as CallLogRow[];
    }
    return this.db
      .prepare(`SELECT * FROM call_logs ORDER BY startedAtEpochMs DESC LIMIT ?`)
      .all(limit) as CallLogRow[];
  }

  /** Daily report: calls made, connected, total duration, by agent, for a given day range. */
  getDailyReport(dayStartEpochMs: number, dayEndEpochMs: number): {
    agent: string;
    totalCalls: number;
    connected: number;
    noAnswer: number;
    busy: number;
    failed: number;
    rejected: number;
    totalDurationSeconds: number;
    avgDurationSeconds: number;
  }[] {
    return this.db
      .prepare(
        `SELECT
           agent,
           COUNT(*) as totalCalls,
           SUM(CASE WHEN status='CONNECTED' THEN 1 ELSE 0 END) as connected,
           SUM(CASE WHEN status='NO_ANSWER' THEN 1 ELSE 0 END) as noAnswer,
           SUM(CASE WHEN status='BUSY' THEN 1 ELSE 0 END) as busy,
           SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status='REJECTED' THEN 1 ELSE 0 END) as rejected,
           SUM(durationSeconds) as totalDurationSeconds,
           CAST(ROUND(AVG(CASE WHEN status='CONNECTED' THEN durationSeconds END)) AS INTEGER) as avgDurationSeconds
         FROM call_logs
         WHERE startedAtEpochMs >= ? AND startedAtEpochMs < ?
         GROUP BY agent
         ORDER BY totalCalls DESC`
      )
      .all(dayStartEpochMs, dayEndEpochMs) as any;
  }

  // ---------- Settings ----------

  getSetting(key: string): string | undefined {
    const r = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return r?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

/** Normalizes a mobile number for duplicate comparison: strips +91, spaces, dashes, leading zeros. */
export function normalizeMobile(mobile: string): string {
  if (!mobile) return "";
  let m = mobile.replace(/[\s\-()]/g, "");
  m = m.replace(/^\+?91/, "");
  m = m.replace(/^0+/, "");
  return m.trim();
}
