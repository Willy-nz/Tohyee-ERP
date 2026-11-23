import { writeAuditEvent } from "@/lib/audit";
import { parseDelimited } from "@/lib/bank/formats/table";
import { fromCsvCell, toCsv } from "@/lib/csv";
import type { OrgTx } from "@/lib/db/org-transaction";
import { HttpError, ValidationError } from "@/lib/errors";
import { SPREAD_KIND_LABELS, SPREAD_KINDS, SPREAD_METHOD_LABELS, type SpreadKind, type SpreadMethod } from "@/lib/spreading/rules";
import { previewSpreadMonth } from "@/lib/spreading/runs";
import { createSpreadItem, listSpreadItems, parseKind } from "@/lib/spreading/service";
import { asRecord, requireIdempotencyKey, requireString } from "@/lib/validation";

/**
 * The worksheet as files (example SW23): a month's journal to enter in other
 * software, the worksheet itself, and items brought in from a file.
 */

export type SpreadFile = { fileName: string; csv: string };

const FILE_KIND: Record<SpreadKind, string> = {
  prepayment: "paid-in-advance",
  income_in_advance: "income-in-advance",
  accrued_expense: "not-billed-yet",
  accrued_income: "not-invoiced-yet",
};

/** A kind's month as journal rows: what was posted, or what would be if it hasn't posted yet. */
export async function monthJournalFile(tx: OrgTx, kindInput: unknown, monthInput: unknown): Promise<SpreadFile> {
  const preview = await previewSpreadMonth(tx, kindInput, monthInput);
  const codes = [...new Set(preview.journalLines.map((line) => line.accountCode))];
  const names = new Map(
    (await tx.query<{ code: string; name: string }>("select code, name from accounts where code = any($1::text[])", [codes])).rows.map((row) => [row.code, row.name]),
  );
  const rows: string[][] = [["Date", "Reference", "Description", "Account code", "Account name", "Debit", "Credit"]];
  for (const line of preview.journalLines) {
    rows.push([preview.postingDate, preview.reference, line.description, line.accountCode, names.get(line.accountCode) ?? "", line.debitAmount === "0.00" ? "" : line.debitAmount, line.creditAmount === "0.00" ? "" : line.creditAmount]);
  }
  await writeAuditEvent(tx, { eventType: "spreading.journal_exported", entityType: "spread_run", entityId: preview.runId ?? "0", details: { kind: preview.kind, month: preview.month, posted: preview.runId !== null } });
  return { fileName: `spreading-${FILE_KIND[preview.kind]}-${preview.month}.csv`, csv: toCsv(rows) };
}

/** A kind's items, a row each, with a column a month. */
export async function worksheetFile(tx: OrgTx, kindInput: unknown): Promise<SpreadFile> {
  const kind = parseKind(kindInput);
  const items = await listSpreadItems(tx, { kind });
  const months = [...new Set(items.flatMap((item) => item.months.map((row) => row.month)))].sort();
  const rows: string[][] = [["What", "Account code", "Account name", "How", "From", "To", "Amount", kind === "prepayment" || kind === "income_in_advance" ? "Left" : "Accrued", ...months]];
  for (const item of items) {
    rows.push([
      item.description,
      item.target.code,
      item.target.name,
      SPREAD_METHOD_LABELS[item.method],
      item.startDate ?? "",
      item.endDate ?? "",
      item.amount,
      item.left,
      ...months.map((month) => {
        const cells = item.months.filter((row) => row.month === month);
        return cells.length === 0 ? "" : sumText(cells.map((row) => row.amount));
      }),
    ]);
  }
  await writeAuditEvent(tx, { eventType: "spreading.worksheet_exported", entityType: "spreading_settings", entityId: "1", details: { kind, items: items.length } });
  return { fileName: `spreading-${FILE_KIND[kind]}.csv`, csv: toCsv(rows) };
}

/** Adds decimal strings in cents (whole-cent amounts only), without floats in the result. */
function sumText(amounts: string[]): string {
  let cents = BigInt(0);
  for (const amount of amounts) {
    const negative = amount.startsWith("-");
    const [whole, fraction = ""] = amount.replace("-", "").split(".");
    const value = BigInt(whole) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
    cents += negative ? -value : value;
  }
  const negative = cents < BigInt(0);
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}

const IMPORT_HEADINGS = ["Kind", "What", "Amount", "Account code", "How", "From", "To", "Month"] as const;

/** An empty file to fill in, with one made-up row to show the shape. */
export function importTemplateFile(): SpreadFile {
  return {
    fileName: "spreading-import.csv",
    csv: toCsv([
      [...IMPORT_HEADINGS],
      ["Paid in advance", "Farm insurance", "1200.00", "6080", "Evenly by month", "2026-07-01", "2027-06-30", ""],
      ["Income in advance", "Event deposit", "500.00", "4000", "All in one month", "", "", "2027-03"],
    ]),
  };
}

function lookup<T extends string>(labels: Record<T, string>, keys: readonly T[], input: string, what: string): T {
  const wanted = input.trim().toLowerCase();
  const found = keys.find((key) => key === wanted || labels[key].toLowerCase() === wanted);
  if (!found) throw new ValidationError(`${what} "${input}" isn't one of: ${keys.map((key) => labels[key]).join(", ")}.`);
  return found;
}

/** 2026-07-01, or 1/7/2026 as a spreadsheet writes it. */
function fileDate(input: string): string {
  const text = input.trim();
  const dayFirst = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  return dayFirst ? `${dayFirst[3]}-${dayFirst[2].padStart(2, "0")}-${dayFirst[1].padStart(2, "0")}` : text;
}

const IMPORT_METHODS: readonly SpreadMethod[] = ["by_month", "by_days", "one_month", "when_done"];

/**
 * Brings items in from a CSV file (bookkeepers; SW23): the template's
 * columns, a row an item. All of them or none: a row that can't be added
 * stops the import and says which row.
 */
export async function importSpreadItems(tx: OrgTx, bodyInput: unknown): Promise<{ added: number }> {
  const body = asRecord(bodyInput, "body");
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const text = requireString(body.csv, "The file", { maxLength: 500_000 });
  const rows = parseDelimited(text).map((row) => row.map((cell) => fromCsvCell(cell).trim()));
  const header = rows[0]?.map((cell) => cell.toLowerCase()) ?? [];
  const column = (name: (typeof IMPORT_HEADINGS)[number]) => header.indexOf(name.toLowerCase());
  const missing = (["Kind", "What", "Amount", "Account code"] as const).filter((name) => column(name) < 0);
  if (missing.length > 0) throw new ValidationError(`The file's first row needs these headings: ${IMPORT_HEADINGS.join(", ")}. Missing: ${missing.join(", ")}.`);
  const data = rows.slice(1).filter((row) => row.some((cell) => cell !== ""));
  if (data.length === 0) throw new ValidationError("The file has no rows under its headings.");
  if (data.length > 500) throw new ValidationError("A file can bring in up to 500 items at a time.");
  let added = 0;
  for (const [index, row] of data.entries()) {
    const cell = (name: (typeof IMPORT_HEADINGS)[number]) => (column(name) < 0 ? "" : (row[column(name)] ?? ""));
    try {
      const kind = lookup(SPREAD_KIND_LABELS, SPREAD_KINDS, cell("Kind"), "Kind");
      const method = cell("How") === "" ? "by_month" : lookup(SPREAD_METHOD_LABELS, IMPORT_METHODS, cell("How"), "How");
      const result = await createSpreadItem(tx, {
        source: "import",
        idempotencyKey: `${idempotencyKey}-row-${index + 1}`,
        kind,
        description: cell("What"),
        amount: cell("Amount"),
        targetAccountCode: cell("Account code"),
        method,
        startDate: fileDate(cell("From")),
        endDate: fileDate(cell("To")),
        month: cell("Month"),
      });
      if (result.created) added += 1;
    } catch (error) {
      if (error instanceof HttpError) throw new ValidationError(`Row ${index + 2}: ${error.message}`);
      throw error;
    }
  }
  await writeAuditEvent(tx, { eventType: "spreading.items_imported", entityType: "spreading_settings", entityId: "1", details: { rows: data.length, added } });
  return { added };
}
