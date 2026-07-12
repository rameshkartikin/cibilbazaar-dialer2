/**
 * CibilBazaar Dialer — simple rotating file logger.
 * Writes to <userData>/logs/dialer-YYYY-MM-DD.log and mirrors to console.
 * No external deps — keeps the app fully offline-capable and lightweight.
 */
import fs from "fs";
import path from "path";
import { app, BrowserWindow } from "electron";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

export class Logger {
  private logDir: string;
  private mainWindow: BrowserWindow | null = null;

  constructor() {
    const userData = app ? app.getPath("userData") : path.join(process.cwd(), ".data");
    this.logDir = path.join(userData, "logs");
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    this.pruneOldLogs();
  }

  /** Lets the logger push log lines to the renderer's live "Logs" panel. */
  attachWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  private currentLogFile(): string {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
    return path.join(this.logDir, `dialer-${stamp}.log`);
  }

  private pruneOldLogs(retainDays = 30): void {
    try {
      const files = fs.readdirSync(this.logDir);
      const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
      for (const f of files) {
        const full = path.join(this.logDir, f);
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
      }
    } catch {
      // non-fatal — logging must never crash the app
    }
  }

  private write(level: LogLevel, message: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    try {
      fs.appendFileSync(this.currentLogFile(), line, "utf8");
    } catch {
      // ignore disk errors, still show in console
    }
    const consoleFn = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
    consoleFn(line.trim());

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("log:entry", { level, message, ts: Date.now() });
    }
  }

  info(message: string): void {
    this.write("INFO", message);
  }
  warn(message: string): void {
    this.write("WARN", message);
  }
  error(message: string): void {
    this.write("ERROR", message);
  }
  debug(message: string): void {
    this.write("DEBUG", message);
  }

  /** Returns the last N lines of today's log for the UI "Logs" tab initial load. */
  tail(lines = 200): string[] {
    try {
      const content = fs.readFileSync(this.currentLogFile(), "utf8");
      const all = content.split("\n").filter(Boolean);
      return all.slice(-lines);
    } catch {
      return [];
    }
  }
}
