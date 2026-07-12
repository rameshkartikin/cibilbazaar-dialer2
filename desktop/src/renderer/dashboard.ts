/**
 * CibilBazaar Dialer — Dashboard component.
 * Renders KPI tiles and the agent performance table shared by both the
 * Dashboard tab (today only) and the Daily Report tab (any chosen date).
 */
import { formatDuration } from "./grid";

export interface ContactSummary {
  total: number;
  connectedToday: number;
  pending: number;
  duplicates: number;
}

export interface AgentReportRow {
  agent: string;
  totalCalls: number;
  connected: number;
  noAnswer: number;
  busy: number;
  failed: number;
  rejected: number;
  totalDurationSeconds: number;
  avgDurationSeconds: number;
}

export function renderKpis(summary: ContactSummary): void {
  setText("kpiTotal", String(summary.total));
  setText("kpiConnected", String(summary.connectedToday));
  setText("kpiPending", String(summary.pending));
  setText("kpiDuplicates", String(summary.duplicates));
}

export function renderReportTable(tableId: string, rows: AgentReportRow[]): void {
  const table = document.getElementById(tableId) as HTMLTableElement | null;
  if (!table) return;
  const tbody = table.querySelector("tbody")!;
  tbody.innerHTML = "";

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 10;
    td.textContent = "No calls recorded for this period.";
    td.className = "muted";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const r of rows) {
    const tr = document.createElement("tr");
    const connectRate = r.totalCalls > 0 ? Math.round((r.connected / r.totalCalls) * 100) : 0;
    const cells = [
      r.agent || "(unassigned)",
      String(r.totalCalls),
      String(r.connected),
      String(r.noAnswer),
      String(r.busy),
      String(r.failed),
      String(r.rejected),
      `${connectRate}%`,
      formatDuration(r.avgDurationSeconds || 0),
      formatDuration(r.totalDurationSeconds),
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
