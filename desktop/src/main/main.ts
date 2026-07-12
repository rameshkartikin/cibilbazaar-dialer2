/**
 * CibilBazaar Dialer — Electron main process entry point.
 * Boots the window, DB, transport manager, and call engine, and exposes
 * everything to the renderer via IPC (see preload.ts for the safe surface).
 */
import { app, BrowserWindow, ipcMain, dialog, shell, Notification } from "electron";
import path from "path";
import fs from "fs";
import { DialerDatabase } from "./db";
import { importExcel, exportToExcel, validateExcel } from "./excelService";
import { Logger } from "./logger";
import { WifiTransport } from "./wifiTransport";
import { BluetoothTransport } from "./bluetoothTransport";
import { UsbTransport } from "./usbTransport";
import { TransportManager } from "./transportManager";
import { CallEngine } from "./callEngine";

let mainWindow: BrowserWindow | null = null;
let db: DialerDatabase;
let logger: Logger;
let transportManager: TransportManager;
let callEngine: CallEngine;
let activeExcelPath: string | null = null;
let autoSaveTimer: NodeJS.Timeout | null = null;

function generatePairingCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0f1115",
    title: "CibilBazaar Dialer",
    webPreferences: {
      preload: path.join(__dirname, "..", "main", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  logger.attachWindow(mainWindow);
}

function todayIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const notifiedFollowupIds = new Set<string>();

function checkFollowupReminders(): void {
  const due = db.getDueFollowups(todayIsoDate());
  const fresh = due.filter((c) => !notifiedFollowupIds.has(c.id));
  mainWindow?.webContents.send("followups:due", due);

  for (const contact of fresh) {
    notifiedFollowupIds.add(contact.id);
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: "Follow-up Reminder — CibilBazaar Dialer",
        body: `${contact.name || contact.mobile} (${contact.company || "-"}) is due for follow-up today.`,
      });
      notif.on("click", () => {
        mainWindow?.show();
        mainWindow?.webContents.send("followups:focusRow", contact.id);
      });
      notif.show();
    }
  }
}

function scheduleAutoSave(): void {
  if (!activeExcelPath) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    try {
      await exportToExcel(activeExcelPath!, db);
      logger.info(`Auto-save: wrote changes to ${activeExcelPath}`);
      mainWindow?.webContents.send("excel:saved", { path: activeExcelPath, at: Date.now() });
    } catch (err: any) {
      logger.error(`Auto-save failed: ${err.message}`);
    }
  }, 2000);
}

app.whenReady().then(() => {
  logger = new Logger();
  db = new DialerDatabase();

  const pairingCode = generatePairingCode();
  const wifi = new WifiTransport({ pairingCode, logger });
  const bluetooth = new BluetoothTransport({ logger });
  const usb = new UsbTransport({ logger });
  transportManager = new TransportManager(logger, wifi, bluetooth, usb);

  callEngine = new CallEngine(db, transportManager, logger, scheduleAutoSave);

  transportManager.on("state-change", (state, active) => {
    mainWindow?.webContents.send("transport:state", { state, active });
  });
  callEngine.on("bulk-state-change", (state) => {
    mainWindow?.webContents.send("bulk:state", state);
  });
  callEngine.on("queue-progress", (done, total) => {
    mainWindow?.webContents.send("bulk:progress", { done, total });
  });
  callEngine.on("call-started", (contact) => {
    mainWindow?.webContents.send("call:started", contact);
  });
  callEngine.on("call-finished", (contact) => {
    mainWindow?.webContents.send("call:finished", contact);
    mainWindow?.webContents.send("contacts:updated", [contact]);
  });
  callEngine.on("call-timeout", (contact) => {
    mainWindow?.webContents.send("call:timeout", contact);
  });

  transportManager.start().catch((err) => logger.error(`Transport start failed: ${err.message}`));

  createWindow();
  registerIpcHandlers(pairingCode);

  checkFollowupReminders();
  setInterval(checkFollowupReminders, 60_000); // every minute

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  transportManager?.stop();
  db?.close();
  if (process.platform !== "darwin") app.quit();
});

function registerIpcHandlers(pairingCode: string): void {
  // ---- Excel ----
  ipcMain.handle("excel:pickAndImport", async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "Import Excel",
      filters: [{ name: "Excel Files", extensions: ["xlsx"] }],
      properties: ["openFile"],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const filePath = res.filePaths[0];
    const issues = await validateExcel(filePath);
    if (issues.length > 0) {
      return { error: issues.map((i) => i.message).join("; ") };
    }
    const result = await importExcel(filePath, db);
    activeExcelPath = filePath;
    logger.info(`Excel imported: ${filePath} (${result.imported}/${result.totalRows} rows)`);
    return { result, contacts: db.getAllContacts() };
  });

  ipcMain.handle("excel:exportAs", async () => {
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: "Export Excel",
      defaultPath: "CibilBazaar-Export.xlsx",
      filters: [{ name: "Excel Files", extensions: ["xlsx"] }],
    });
    if (res.canceled || !res.filePath) return null;
    await exportToExcel(res.filePath, db);
    logger.info(`Excel exported to ${res.filePath}`);
    return { path: res.filePath };
  });

  // ---- Contacts / Grid ----
  ipcMain.handle("contacts:getAll", () => db.getAllContacts());

  ipcMain.handle("contacts:search", (_e, query: string, filters: any) => db.searchContacts(query, filters));

  ipcMain.handle("contacts:updateField", (_e, id: string, field: "remarks" | "followup" | "status" | "agent" | "outcome", value: string) => {
    const updated = db.updateField(id, field, value);
    scheduleAutoSave();
    return updated;
  });

  // ---- WhatsApp / SMS ----
  ipcMain.handle("whatsapp:open", async (_e, mobile: string, message?: string) => {
    const normalized = mobile.replace(/[^\d+]/g, "");
    const withCountryCode = normalized.startsWith("+") ? normalized.slice(1) : normalized.length === 10 ? `91${normalized}` : normalized;
    const url = `https://wa.me/${withCountryCode}${message ? `?text=${encodeURIComponent(message)}` : ""}`;
    await shell.openExternal(url);
    logger.info(`WhatsApp opened for ${mobile}`);
    return { ok: true };
  });

  ipcMain.handle("sms:send", async (_e, rowId: string, message?: string) => {
    try {
      await callEngine.sendSms(rowId, message);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ---- Follow-up reminders ----
  ipcMain.handle("followups:getDue", () => db.getDueFollowups(todayIsoDate()));

  // ---- Auto Next Lead ----
  ipcMain.handle("engine:setAutoNext", (_e, enabled: boolean) => {
    callEngine.setAutoNextLead(enabled);
    return { ok: true };
  });
  ipcMain.handle("engine:getAutoNext", () => callEngine.getAutoNextLead());

  // ---- Calling ----
  ipcMain.handle("call:single", async (_e, rowId: string) => {
    try {
      await callEngine.callSingle(rowId);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("bulk:start", (_e, rowIds?: string[]) => {
    callEngine.startBulk(rowIds);
    return { ok: true };
  });
  ipcMain.handle("bulk:pause", () => {
    callEngine.pauseBulk();
    return { ok: true };
  });
  ipcMain.handle("bulk:resume", () => {
    callEngine.resumeBulk();
    return { ok: true };
  });
  ipcMain.handle("bulk:stop", () => {
    callEngine.stopBulk();
    return { ok: true };
  });
  ipcMain.handle("bulk:state", () => callEngine.getBulkState());

  // ---- Transport / Pairing ----
  ipcMain.handle("transport:getPairingCode", () => pairingCode);
  ipcMain.handle("transport:getState", () => transportManager.getState());
  ipcMain.handle("transport:bluetoothDiscover", async () => {
    const bt = (transportManager as any).transports.BLUETOOTH;
    return bt.discover();
  });
  ipcMain.handle("transport:setBluetoothTarget", (_e, address: string) => {
    transportManager.setBluetoothTarget(address);
    transportManager.start();
    return { ok: true };
  });
  ipcMain.handle("transport:listUsbPorts", async () => {
    const { UsbTransport: UT } = await import("./usbTransport");
    return UT.listCandidatePorts();
  });
  ipcMain.handle("transport:setUsbTarget", (_e, portPath: string) => {
    transportManager.setUsbTarget(portPath);
    transportManager.start();
    return { ok: true };
  });

  // ---- Reports / History ----
  ipcMain.handle("reports:daily", (_e, dayStartEpochMs: number, dayEndEpochMs: number) =>
    db.getDailyReport(dayStartEpochMs, dayEndEpochMs)
  );
  ipcMain.handle("history:get", (_e, contactId?: string, limit?: number) => db.getCallHistory(contactId, limit));

  // ---- Logs ----
  ipcMain.handle("logs:tail", (_e, lines?: number) => logger.tail(lines));

  // ---- Settings ----
  ipcMain.handle("settings:get", (_e, key: string) => db.getSetting(key));
  ipcMain.handle("settings:set", (_e, key: string, value: string) => {
    db.setSetting(key, value);
    return { ok: true };
  });
}
