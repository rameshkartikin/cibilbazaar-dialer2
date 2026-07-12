/**
 * CibilBazaar Dialer — Excel import/export service (.xlsx via exceljs).
 * Excel is the human-facing source file; DialerDatabase mirrors it for
 * fast search/filter. Import fills the DB; export writes the DB back out.
 */
import ExcelJS from "exceljs";
import { DialerDatabase, ContactRow, CallStatusValue, normalizeMobile } from "./db";
import { cryptoRandomId } from "../shared/protocol";

const COLUMN_ORDER = [
  "Name",
  "Company",
  "Mobile",
  "Status",
  "Outcome",
  "Remarks",
  "Followup",
  "Duration",
  "Agent",
] as const;

const VALID_STATUSES: CallStatusValue[] = [
  "PENDING",
  "CONNECTED",
  "NO_ANSWER",
  "BUSY",
  "FAILED",
  "REJECTED",
];

const VALID_OUTCOMES = ["", "INTERESTED", "BUSY", "NO_ANSWER", "CALLBACK", "REJECTED"];

function coerceStatus(raw: unknown): CallStatusValue {
  const s = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  return (VALID_STATUSES as string[]).includes(s) ? (s as CallStatusValue) : "PENDING";
}

function coerceOutcome(raw: unknown): string {
  const s = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  return VALID_OUTCOMES.includes(s) ? s : "";
}

function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell || cell.value === null || cell.value === undefined) return "";
  const v = cell.value as any;
  if (typeof v === "object" && v.text) return String(v.text);
  if (typeof v === "object" && v.result !== undefined) return String(v.result);
  return String(v);
}

export interface ImportResult {
  totalRows: number;
  imported: number;
  duplicatesFound: number;
  skippedEmptyRows: number;
}

export async function importExcel(filePath: string, db: DialerDatabase): Promise<ImportResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Excel file has no worksheets.");

  const headerRow = sheet.getRow(1);
  const headerMap: Record<string, number> = {};
  headerRow.eachCell((cell, colNumber) => {
    const label = cellText(cell).trim().toLowerCase();
    headerMap[label] = colNumber;
  });

  const colFor = (name: string): number | undefined => headerMap[name.toLowerCase()];

  const nameCol = colFor("Name");
  const companyCol = colFor("Company");
  const mobileCol = colFor("Mobile") ?? colFor("Mobile Number") ?? colFor("Phone");
  const statusCol = colFor("Status");
  const outcomeCol = colFor("Outcome");
  const remarksCol = colFor("Remarks");
  const followupCol = colFor("Followup") ?? colFor("Follow-up") ?? colFor("Follow Up");
  const durationCol = colFor("Duration");
  const agentCol = colFor("Agent");

  if (!mobileCol) {
    throw new Error('Excel must contain a "Mobile" column.');
  }

  let totalRows = 0;
  let imported = 0;
  let duplicatesFound = 0;
  let skippedEmptyRows = 0;
  const seenMobiles = new Set<string>();

  const rowCount = sheet.rowCount;
  for (let r = 2; r <= rowCount; r++) {
    const row = sheet.getRow(r);
    const mobileRaw = mobileCol ? cellText(row.getCell(mobileCol)) : "";
    const nameRaw = nameCol ? cellText(row.getCell(nameCol)) : "";
    if (!mobileRaw.trim() && !nameRaw.trim()) {
      skippedEmptyRows++;
      continue;
    }
    totalRows++;

    const mobile = mobileRaw.trim();
    const normalized = normalizeMobile(mobile);
    if (normalized && seenMobiles.has(normalized)) {
      duplicatesFound++;
    } else if (normalized) {
      seenMobiles.add(normalized);
    }

    const durationRaw = durationCol ? cellText(row.getCell(durationCol)) : "0";
    const durationParsed = parseInt(durationRaw.replace(/[^\d-]/g, ""), 10);

    const contact: Omit<ContactRow, "createdAt" | "updatedAt" | "mobileNormalized" | "isDuplicate"> = {
      id: cryptoRandomId(),
      name: nameRaw.trim(),
      company: companyCol ? cellText(row.getCell(companyCol)).trim() : "",
      mobile,
      status: statusCol ? coerceStatus(cellText(row.getCell(statusCol))) : "PENDING",
      outcome: outcomeCol ? (coerceOutcome(cellText(row.getCell(outcomeCol))) as any) : "",
      remarks: remarksCol ? cellText(row.getCell(remarksCol)).trim() : "",
      followup: followupCol ? cellText(row.getCell(followupCol)).trim() : "",
      duration: Number.isFinite(durationParsed) ? durationParsed : 0,
      agent: agentCol ? cellText(row.getCell(agentCol)).trim() : "",
    };

    db.upsertContact(contact);
    imported++;
  }

  return { totalRows, imported, duplicatesFound, skippedEmptyRows };
}

export async function exportToExcel(filePath: string, db: DialerDatabase): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Contacts");

  sheet.columns = COLUMN_ORDER.map((h) => ({
    header: h,
    key: h.toLowerCase(),
    width: h === "Remarks" ? 30 : h === "Name" || h === "Company" ? 22 : 16,
  }));

  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F2937" },
  };

  const contacts = db.getAllContacts();
  for (const c of contacts) {
    const row = sheet.addRow({
      name: c.name,
      company: c.company,
      mobile: c.mobile,
      status: c.status,
      outcome: c.outcome,
      remarks: c.remarks,
      followup: c.followup,
      duration: c.duration,
      agent: c.agent,
    });
    if (c.isDuplicate) {
      row.eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFF3CD" },
        };
      });
    }
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: COLUMN_ORDER.length },
  };

  await workbook.xlsx.writeFile(filePath);
}

export interface ExcelValidationIssue {
  row: number;
  message: string;
}

/** Pre-import validation pass — used by the UI to show a preview/confirmation before committing. */
export async function validateExcel(filePath: string): Promise<ExcelValidationIssue[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const issues: ExcelValidationIssue[] = [];
  if (!sheet) {
    issues.push({ row: 0, message: "No worksheet found in file." });
    return issues;
  }
  const headerRow = sheet.getRow(1);
  const headers = new Set<string>();
  headerRow.eachCell((cell) => headers.add(cellText(cell).trim().toLowerCase()));
  if (!headers.has("mobile") && !headers.has("mobile number") && !headers.has("phone")) {
    issues.push({ row: 1, message: 'Missing required "Mobile" column.' });
  }
  return issues;
}
