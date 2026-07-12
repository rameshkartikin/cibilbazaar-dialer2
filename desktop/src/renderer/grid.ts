/**
 * CibilBazaar Dialer — Data grid component.
 * Renders the contacts table with inline-editable Remarks/Followup/Agent
 * cells, status badges, duplicate row highlighting, and a per-row Call
 * button. No framework — plain DOM for a lightweight, fast-loading grid.
 */

export interface ContactRow {
  id: string;
  name: string;
  company: string;
  mobile: string;
  status: string;
  outcome: string;
  remarks: string;
  followup: string;
  duration: number;
  agent: string;
  isDuplicate: number;
}

export type FieldName = "remarks" | "followup" | "status" | "agent" | "outcome";

export interface GridCallbacks {
  onCall: (rowId: string) => void;
  onWhatsapp: (rowId: string) => void;
  onSms: (rowId: string) => void;
  onFieldEdit: (rowId: string, field: FieldName, value: string) => void;
}

const STATUS_OPTIONS = ["PENDING", "CONNECTED", "NO_ANSWER", "BUSY", "FAILED", "REJECTED"];
const OUTCOME_OPTIONS = ["", "INTERESTED", "BUSY", "NO_ANSWER", "CALLBACK", "REJECTED"];

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "-";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export class DataGrid {
  private tbody: HTMLTableSectionElement;

  constructor(private mountEl: HTMLTableSectionElement, private callbacks: GridCallbacks) {
    this.tbody = mountEl;
  }

  render(rows: ContactRow[]): void {
    this.tbody.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const row of rows) frag.appendChild(this.buildRow(row));
    this.tbody.appendChild(frag);
  }

  /** Patches a single row in place without a full re-render (used after call results). */
  updateRow(row: ContactRow): void {
    const existing = this.tbody.querySelector<HTMLTableRowElement>(`tr[data-id="${row.id}"]`);
    const rebuilt = this.buildRow(row);
    if (existing) existing.replaceWith(rebuilt);
  }

  private buildRow(row: ContactRow): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    if (row.isDuplicate) tr.classList.add("duplicate-row");

    tr.appendChild(this.td(row.name));
    tr.appendChild(this.td(row.company));
    tr.appendChild(this.td(row.mobile));
    tr.appendChild(this.statusCell(row));
    tr.appendChild(this.outcomeCell(row));
    tr.appendChild(this.editableTd(row.id, "remarks", row.remarks));
    tr.appendChild(this.editableTd(row.id, "followup", row.followup, "date"));
    tr.appendChild(this.td(formatDuration(row.duration)));
    tr.appendChild(this.editableTd(row.id, "agent", row.agent));
    tr.appendChild(this.actionsCell(row));

    return tr;
  }

  private td(text: string): HTMLTableCellElement {
    const cell = document.createElement("td");
    cell.textContent = text || "-";
    return cell;
  }

  private statusCell(row: ContactRow): HTMLTableCellElement {
    const cell = document.createElement("td");
    const select = document.createElement("select");
    select.className = "select";
    for (const opt of STATUS_OPTIONS) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt.replace("_", " ");
      if (opt === row.status) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener("change", () => {
      this.callbacks.onFieldEdit(row.id, "status", select.value);
    });
    const badge = document.createElement("span");
    badge.className = `status-badge status-${row.status}`;
    badge.textContent = row.status.replace("_", " ");
    cell.appendChild(badge);
    cell.appendChild(select);
    select.style.display = "none";
    badge.style.cursor = "pointer";
    badge.addEventListener("click", () => {
      badge.style.display = "none";
      select.style.display = "inline-block";
      select.focus();
    });
    select.addEventListener("blur", () => {
      select.style.display = "none";
      badge.style.display = "inline-block";
    });
    return cell;
  }

  private editableTd(rowId: string, field: FieldName, value: string, type: "text" | "date" = "text"): HTMLTableCellElement {
    const cell = document.createElement("td");
    const div = document.createElement("div");
    div.className = "editable-cell";
    div.contentEditable = "true";
    div.textContent = value || "";
    div.setAttribute("data-placeholder", type === "date" ? "YYYY-MM-DD" : "-");
    div.addEventListener("blur", () => {
      const newVal = div.textContent?.trim() ?? "";
      if (newVal !== value) this.callbacks.onFieldEdit(rowId, field, newVal);
    });
    div.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        div.blur();
      }
    });
    cell.appendChild(div);
    return cell;
  }

  private outcomeCell(row: ContactRow): HTMLTableCellElement {
    const cell = document.createElement("td");
    const select = document.createElement("select");
    select.className = "select outcome-select";
    for (const opt of OUTCOME_OPTIONS) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt ? opt.charAt(0) + opt.slice(1).toLowerCase().replace("_", " ") : "-- Set outcome --";
      if (opt === row.outcome) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener("change", () => {
      this.callbacks.onFieldEdit(row.id, "outcome", select.value);
    });
    cell.appendChild(select);
    return cell;
  }

  private actionsCell(row: ContactRow): HTMLTableCellElement {
    const cell = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "row-actions";

    const callBtn = document.createElement("button");
    callBtn.className = "btn-call";
    callBtn.title = "Call";
    callBtn.textContent = "📞";
    callBtn.addEventListener("click", () => this.callbacks.onCall(row.id));

    const waBtn = document.createElement("button");
    waBtn.className = "btn-icon btn-whatsapp";
    waBtn.title = "Open WhatsApp";
    waBtn.textContent = "💬";
    waBtn.addEventListener("click", () => this.callbacks.onWhatsapp(row.id));

    const smsBtn = document.createElement("button");
    smsBtn.className = "btn-icon btn-sms";
    smsBtn.title = "Send SMS (via paired phone)";
    smsBtn.textContent = "✉️";
    smsBtn.addEventListener("click", () => this.callbacks.onSms(row.id));

    wrap.appendChild(callBtn);
    wrap.appendChild(waBtn);
    wrap.appendChild(smsBtn);
    cell.appendChild(wrap);
    return cell;
  }
}
