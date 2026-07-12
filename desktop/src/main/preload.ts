/**
 * CibilBazaar Dialer — preload script.
 * Exposes a narrow, typed `window.dialer` API to the renderer via
 * contextBridge. Renderer never touches ipcRenderer/Node directly.
 */
import { contextBridge, ipcRenderer } from "electron";

const api = {
  excel: {
    pickAndImport: () => ipcRenderer.invoke("excel:pickAndImport"),
    exportAs: () => ipcRenderer.invoke("excel:exportAs"),
    onSaved: (cb: (info: { path: string; at: number }) => void) => {
      ipcRenderer.on("excel:saved", (_e, info) => cb(info));
    },
  },
  contacts: {
    getAll: () => ipcRenderer.invoke("contacts:getAll"),
    search: (query: string, filters: any) => ipcRenderer.invoke("contacts:search", query, filters),
    updateField: (id: string, field: string, value: string) =>
      ipcRenderer.invoke("contacts:updateField", id, field, value),
    onUpdated: (cb: (rows: any[]) => void) => {
      ipcRenderer.on("contacts:updated", (_e, rows) => cb(rows));
    },
  },
  call: {
    single: (rowId: string) => ipcRenderer.invoke("call:single", rowId),
    onStarted: (cb: (contact: any) => void) => ipcRenderer.on("call:started", (_e, c) => cb(c)),
    onFinished: (cb: (contact: any) => void) => ipcRenderer.on("call:finished", (_e, c) => cb(c)),
    onTimeout: (cb: (contact: any) => void) => ipcRenderer.on("call:timeout", (_e, c) => cb(c)),
  },
  whatsapp: {
    open: (mobile: string, message?: string) => ipcRenderer.invoke("whatsapp:open", mobile, message),
  },
  sms: {
    send: (rowId: string, message?: string) => ipcRenderer.invoke("sms:send", rowId, message),
  },
  followups: {
    getDue: () => ipcRenderer.invoke("followups:getDue"),
    onDue: (cb: (rows: any[]) => void) => ipcRenderer.on("followups:due", (_e, rows) => cb(rows)),
    onFocusRow: (cb: (rowId: string) => void) => ipcRenderer.on("followups:focusRow", (_e, rowId) => cb(rowId)),
  },
  engine: {
    setAutoNext: (enabled: boolean) => ipcRenderer.invoke("engine:setAutoNext", enabled),
    getAutoNext: () => ipcRenderer.invoke("engine:getAutoNext"),
  },
  bulk: {
    start: (rowIds?: string[]) => ipcRenderer.invoke("bulk:start", rowIds),
    pause: () => ipcRenderer.invoke("bulk:pause"),
    resume: () => ipcRenderer.invoke("bulk:resume"),
    stop: () => ipcRenderer.invoke("bulk:stop"),
    getState: () => ipcRenderer.invoke("bulk:state"),
    onStateChange: (cb: (state: string) => void) => ipcRenderer.on("bulk:state", (_e, s) => cb(s)),
    onProgress: (cb: (p: { done: number; total: number }) => void) =>
      ipcRenderer.on("bulk:progress", (_e, p) => cb(p)),
  },
  transport: {
    getPairingCode: () => ipcRenderer.invoke("transport:getPairingCode"),
    getState: () => ipcRenderer.invoke("transport:getState"),
    bluetoothDiscover: () => ipcRenderer.invoke("transport:bluetoothDiscover"),
    setBluetoothTarget: (address: string) => ipcRenderer.invoke("transport:setBluetoothTarget", address),
    listUsbPorts: () => ipcRenderer.invoke("transport:listUsbPorts"),
    setUsbTarget: (portPath: string) => ipcRenderer.invoke("transport:setUsbTarget", portPath),
    onStateChange: (cb: (info: { state: string; active: string | null }) => void) => {
      ipcRenderer.on("transport:state", (_e, info) => cb(info));
    },
  },
  reports: {
    daily: (dayStartEpochMs: number, dayEndEpochMs: number) =>
      ipcRenderer.invoke("reports:daily", dayStartEpochMs, dayEndEpochMs),
  },
  history: {
    get: (contactId?: string, limit?: number) => ipcRenderer.invoke("history:get", contactId, limit),
  },
  logs: {
    tail: (lines?: number) => ipcRenderer.invoke("logs:tail", lines),
    onEntry: (cb: (entry: { level: string; message: string; ts: number }) => void) => {
      ipcRenderer.on("log:entry", (_e, entry) => cb(entry));
    },
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke("settings:get", key),
    set: (key: string, value: string) => ipcRenderer.invoke("settings:set", key, value),
  },
};

contextBridge.exposeInMainWorld("dialer", api);

export type DialerApi = typeof api;
