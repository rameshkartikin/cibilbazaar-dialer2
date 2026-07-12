/**
 * CibilBazaar Dialer — renderer app entry point.
 * Wires up tab navigation, the contacts grid, dashboard, bulk-call
 * controls, search/filter, device pairing screen, logs, and history —
 * all via the `window.dialer` API exposed by preload.ts.
 */
import { DataGrid, ContactRow, FieldName } from "./grid";
import { renderKpis, renderReportTable, AgentReportRow } from "./dashboard";

declare global {
  interface Window {
    dialer: any; // shape matches DialerApi from preload.ts
  }
}

let allContacts: ContactRow[] = [];
let grid: DataGrid;

// ---------- Tab navigation ----------

function initTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      document.getElementById(`view-${tab.dataset.tab}`)?.classList.add("active");

      if (tab.dataset.tab === "history") loadHistory();
      if (tab.dataset.tab === "logs") loadLogs();
      if (tab.dataset.tab === "pairing") loadPairing();
      if (tab.dataset.tab === "dashboard") refreshDashboard();
      if (tab.dataset.tab === "reminders") loadReminders();
    });
  });
}

// ---------- Contacts grid ----------

function initGrid(): void {
  const tbody = document.getElementById("gridBody") as HTMLTableSectionElement;
  grid = new DataGrid(tbody, {
    onCall: async (rowId) => {
      const res = await window.dialer.call.single(rowId);
      if (!res.ok) alert(`Call failed: ${res.error}`);
    },
    onWhatsapp: async (rowId) => {
      const contact = allContacts.find((c) => c.id === rowId);
      if (!contact) return;
      await window.dialer.whatsapp.open(contact.mobile);
    },
    onSms: async (rowId) => {
      const res = await window.dialer.sms.send(rowId);
      if (!res.ok) alert(`SMS failed: ${res.error}\n(Make sure a phone is paired — SMS is sent by opening the composer on the paired Android device.)`);
    },
    onFieldEdit: async (rowId, field: FieldName, value) => {
      const updated = await window.dialer.contacts.updateField(rowId, field, value);
      if (updated) {
        const idx = allContacts.findIndex((c) => c.id === rowId);
        if (idx >= 0) allContacts[idx] = updated;
        grid.updateRow(updated);
        markSaving();
      }
    },
  });
}

async function loadContacts(): Promise<void> {
  allContacts = await window.dialer.contacts.getAll();
  populateAgentFilter();
  applyFilters();
  refreshDashboard();
}

function populateAgentFilter(): void {
  const select = document.getElementById("filterAgent") as HTMLSelectElement;
  const current = select.value;
  const agents = Array.from(new Set(allContacts.map((c) => c.agent).filter(Boolean))).sort();
  select.innerHTML = '<option value="">All Agents</option>';
  for (const a of agents) {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    select.appendChild(opt);
  }
  select.value = current;
}

async function applyFilters(): Promise<void> {
  const query = (document.getElementById("searchBox") as HTMLInputElement).value;
  const status = (document.getElementById("filterStatus") as HTMLSelectElement).value;
  const agent = (document.getElementById("filterAgent") as HTMLSelectElement).value;
  const onlyDuplicates = (document.getElementById("filterDuplicates") as HTMLInputElement).checked;

  const rows = await window.dialer.contacts.search(query, { status, agent, onlyDuplicates });
  grid.render(rows);
}

function initGridToolbar(): void {
  document.getElementById("btnImport")!.addEventListener("click", async () => {
    const res = await window.dialer.excel.pickAndImport();
    if (!res) return;
    if (res.error) {
      alert(`Import failed: ${res.error}`);
      return;
    }
    alert(
      `Imported ${res.result.imported} of ${res.result.totalRows} rows.\n` +
        `Duplicates found: ${res.result.duplicatesFound}\n` +
        `Empty rows skipped: ${res.result.skippedEmptyRows}`
    );
    await loadContacts();
  });

  document.getElementById("btnExport")!.addEventListener("click", async () => {
    const res = await window.dialer.excel.exportAs();
    if (res) alert(`Exported to ${res.path}`);
  });

  let debounce: ReturnType<typeof setTimeout>;
  document.getElementById("searchBox")!.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(applyFilters, 250);
  });
  document.getElementById("filterStatus")!.addEventListener("change", applyFilters);
  document.getElementById("filterAgent")!.addEventListener("change", applyFilters);
  document.getElementById("filterDuplicates")!.addEventListener("change", applyFilters);

  window.dialer.excel.onSaved(() => markSaved());
}

function markSaving(): void {
  const el = document.getElementById("autoSaveIndicator")!;
  el.textContent = "Saving...";
  el.classList.add("saving");
}
function markSaved(): void {
  const el = document.getElementById("autoSaveIndicator")!;
  el.textContent = "Saved";
  el.classList.remove("saving");
}

// ---------- Dashboard ----------

async function refreshDashboard(): Promise<void> {
  const total = allContacts.length;
  const pending = allContacts.filter((c) => c.status === "PENDING").length;
  const duplicates = allContacts.filter((c) => c.isDuplicate).length;

  const { start, end } = todayRange();
  const report: AgentReportRow[] = await window.dialer.reports.daily(start, end);
  const connectedToday = report.reduce((sum, r) => sum + r.connected, 0);

  renderKpis({ total, connectedToday, pending, duplicates });
  renderReportTable("dashboardReportTable", report);
}

function todayRange(): { start: number; end: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return { start, end };
}

// ---------- Bulk calling ----------

function initBulkControls(): void {
  const btnStart = document.getElementById("btnBulkStart") as HTMLButtonElement;
  const btnPause = document.getElementById("btnBulkPause") as HTMLButtonElement;
  const btnResume = document.getElementById("btnBulkResume") as HTMLButtonElement;
  const btnStop = document.getElementById("btnBulkStop") as HTMLButtonElement;
  const autoNextToggle = document.getElementById("autoNextLeadToggle") as HTMLInputElement;

  btnStart.addEventListener("click", () => window.dialer.bulk.start());
  btnPause.addEventListener("click", () => window.dialer.bulk.pause());
  btnResume.addEventListener("click", () => window.dialer.bulk.resume());
  btnStop.addEventListener("click", () => window.dialer.bulk.stop());

  autoNextToggle.addEventListener("change", () => {
    window.dialer.engine.setAutoNext(autoNextToggle.checked);
  });
  window.dialer.engine.getAutoNext().then((enabled: boolean) => {
    autoNextToggle.checked = !!enabled;
  });

  window.dialer.bulk.onStateChange((state: string) => {
    btnStart.disabled = state === "RUNNING" || state === "PAUSED";
    btnPause.disabled = state !== "RUNNING";
    btnResume.disabled = state !== "PAUSED";
    btnStop.disabled = state === "IDLE";
  });

  window.dialer.bulk.onProgress(({ done, total }: { done: number; total: number }) => {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    (document.getElementById("bulkProgressFill") as HTMLDivElement).style.width = `${pct}%`;
    document.getElementById("bulkProgressLabel")!.textContent = `${done} / ${total}`;
  });

  window.dialer.call.onFinished((contact: ContactRow) => {
    const idx = allContacts.findIndex((c) => c.id === contact.id);
    if (idx >= 0) allContacts[idx] = contact;
    grid.updateRow(contact);
    refreshDashboard();
  });
}

// ---------- Call history ----------

async function loadHistory(): Promise<void> {
  const rows = await window.dialer.history.get(undefined, 500);
  const tbody = document.querySelector("#historyTable tbody") as HTMLTableSectionElement;
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    const cells = [
      new Date(r.startedAtEpochMs).toLocaleString(),
      r.mobile,
      r.agent || "-",
      r.status,
      formatDurationLocal(r.durationSeconds),
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function formatDurationLocal(seconds: number): string {
  if (!seconds || seconds <= 0) return "-";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- Daily report tab ----------

function initReportTab(): void {
  const dateInput = document.getElementById("reportDate") as HTMLInputElement;
  const today = new Date();
  dateInput.value = today.toISOString().slice(0, 10);

  document.getElementById("btnLoadReport")!.addEventListener("click", async () => {
    const [y, m, d] = dateInput.value.split("-").map(Number);
    const start = new Date(y, m - 1, d).getTime();
    const end = start + 24 * 60 * 60 * 1000;
    const rows = await window.dialer.reports.daily(start, end);
    renderReportTable("reportTable", rows);
  });
}

// ---------- Logs ----------

async function loadLogs(): Promise<void> {
  const lines: string[] = await window.dialer.logs.tail(300);
  const el = document.getElementById("logConsole")!;
  el.textContent = lines.join("\n");
  el.scrollTop = el.scrollHeight;
}

function initLogStream(): void {
  window.dialer.logs.onEntry((entry: { level: string; message: string; ts: number }) => {
    const el = document.getElementById("logConsole");
    if (!el) return;
    const time = new Date(entry.ts).toISOString();
    el.textContent += `\n[${time}] [${entry.level}] ${entry.message}`;
    el.scrollTop = el.scrollHeight;
  });
}

// ---------- Connection status ----------

function initConnectionStatus(): void {
  window.dialer.transport.onStateChange(({ state, active }: { state: string; active: string | null }) => {
    const dot = document.getElementById("connDot")!;
    const label = document.getElementById("connLabel")!;
    dot.className = "dot " + (state === "CONNECTED" ? "dot-green" : state === "RECONNECTING" || state === "CONNECTING" ? "dot-yellow" : "dot-red");
    label.textContent =
      state === "CONNECTED"
        ? `Connected (${active})`
        : state === "RECONNECTING"
        ? "Reconnecting..."
        : state === "CONNECTING"
        ? "Connecting..."
        : "Disconnected";
  });
}

// ---------- Pairing screen ----------

async function loadPairing(): Promise<void> {
  const code = await window.dialer.transport.getPairingCode();
  document.getElementById("pairingCode")!.textContent = code;
}

function initPairingTab(): void {
  document.getElementById("btnBtScan")!.addEventListener("click", async () => {
    const list = document.getElementById("btDeviceList")!;
    list.innerHTML = "<li>Scanning...</li>";
    const devices = await window.dialer.transport.bluetoothDiscover();
    list.innerHTML = "";
    if (devices.length === 0) {
      list.innerHTML = "<li>No paired devices found. Pair the phone in Windows Bluetooth settings first.</li>";
      return;
    }
    for (const d of devices) {
      const li = document.createElement("li");
      li.textContent = `${d.name} (${d.address})`;
      li.addEventListener("click", async () => {
        await window.dialer.transport.setBluetoothTarget(d.address);
        alert(`Connecting to ${d.name} over Bluetooth...`);
      });
      list.appendChild(li);
    }
  });

  document.getElementById("btnUsbScan")!.addEventListener("click", async () => {
    const list = document.getElementById("usbDeviceList")!;
    list.innerHTML = "<li>Scanning...</li>";
    const ports = await window.dialer.transport.listUsbPorts();
    list.innerHTML = "";
    if (ports.length === 0) {
      list.innerHTML = "<li>No USB serial devices found. Connect the phone via USB cable.</li>";
      return;
    }
    for (const p of ports) {
      const li = document.createElement("li");
      li.textContent = `${p.path}${p.manufacturer ? " — " + p.manufacturer : ""}`;
      li.addEventListener("click", async () => {
        await window.dialer.transport.setUsbTarget(p.path);
        alert(`Connecting via ${p.path}...`);
      });
      list.appendChild(li);
    }
  });
}

// ---------- Follow-up reminders ----------

async function loadReminders(): Promise<void> {
  const rows = await window.dialer.followups.getDue();
  renderRemindersTable(rows);
}

function renderRemindersTable(rows: ContactRow[]): void {
  const tbody = document.querySelector("#remindersTable tbody") as HTMLTableSectionElement;
  tbody.innerHTML = "";

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.className = "muted";
    td.textContent = "No follow-ups due today. Nice and clear!";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.dataset.id = r.id;
    const cells = [r.name || "-", r.company || "-", r.mobile, r.followup, r.remarks || "-", r.agent || "-"];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    const actionTd = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "btn-call";
    btn.textContent = "📞";
    btn.title = "Call now";
    btn.addEventListener("click", async () => {
      const res = await window.dialer.call.single(r.id);
      if (!res.ok) alert(`Call failed: ${res.error}`);
    });
    actionTd.appendChild(btn);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }
}

function updateReminderBadge(count: number): void {
  const badge = document.getElementById("reminderBadge")!;
  if (count > 0) {
    badge.textContent = String(count);
    badge.style.display = "inline-block";
  } else {
    badge.style.display = "none";
  }
}

function initFollowupReminders(): void {
  window.dialer.followups.onDue((rows: ContactRow[]) => {
    updateReminderBadge(rows.length);
    if (document.getElementById("view-reminders")?.classList.contains("active")) {
      renderRemindersTable(rows);
    }
  });

  window.dialer.followups.onFocusRow((rowId: string) => {
    document.querySelector<HTMLButtonElement>('.tab[data-tab="grid"]')?.click();
    setTimeout(() => {
      const row = document.querySelector(`#gridBody tr[data-id="${rowId}"]`);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
      row?.classList.add("duplicate-row");
    }, 200);
  });
}

// ---------- Boot ----------

window.addEventListener("DOMContentLoaded", async () => {
  initTabs();
  initGrid();
  initGridToolbar();
  initBulkControls();
  initReportTab();
  initLogStream();
  initConnectionStatus();
  initPairingTab();
  initFollowupReminders();

  await loadContacts();
});
