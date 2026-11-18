import { decodeText, RowError } from "@/lib/bank/formats/common";
import { parseDelimited } from "@/lib/bank/formats/table";
import { readXlsxRows } from "@/lib/bank/formats/xlsx";
import { writeAuditEvent } from "@/lib/audit";
import { fromCsvCell } from "@/lib/csv";
import type { OrgTx } from "@/lib/db/org-transaction";
import { HttpError, ValidationError } from "@/lib/errors";
import { date, money, number, yesNo } from "@/lib/import/values";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { createEmployee } from "@/lib/payroll/employees";
import { KIWI_SAVER_STATUSES } from "@/lib/payroll/pay-calculation";
import { optionalString, requireIdempotencyKey } from "@/lib/validation";

/**
 * Bringing employees in from a file (examples EMI1-EMI8): a CSV or Excel
 * export from an HR system such as BambooHR, or a spreadsheet typed up by
 * hand. Columns are matched by their headings, and the person can change
 * the matching. Payroll details an HR export often doesn't have (tax code,
 * KiwiSaver, pay frequency) can be given once for every row that has none.
 *
 * Every row goes through createEmployee, so the same rules apply as when
 * an employee is typed in. Each row runs in its own savepoint so every
 * problem is listed, but if any row is refused nothing is saved. A preview
 * runs the same way and always rolls back.
 */

export const MAX_EMPLOYEE_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_EMPLOYEE_IMPORT_ROWS = 2000;

export const EMPLOYEE_IMPORT_FIELDS = [
  { key: "firstName", label: "First name", aliases: ["first name", "first", "given name", "given names", "legal first name"] },
  { key: "lastName", label: "Last name", aliases: ["last name", "last", "surname", "family name", "legal last name"] },
  { key: "email", label: "Email", aliases: ["work email", "email", "email address", "home email", "personal email"] },
  { key: "phone", label: "Phone", aliases: ["mobile phone", "mobile", "work phone", "phone", "phone number", "home phone", "cell phone"] },
  { key: "dateOfBirth", label: "Date of birth", aliases: ["birth date", "date of birth", "birthdate", "dob"] },
  { key: "startDate", label: "Start date", aliases: ["hire date", "start date", "original hire date", "employment start date", "date started"] },
  { key: "finishDate", label: "Finish date", aliases: ["termination date", "finish date", "end date", "employment end date", "date finished"] },
  { key: "jobTitle", label: "Job title", aliases: ["job title", "title", "position", "job information: job title"] },
  { key: "irdNumber", label: "IRD number", aliases: ["ird number", "ird", "ird no", "tax number", "tax file number"] },
  { key: "taxCode", label: "Tax code", aliases: ["tax code"] },
  { key: "bankAccount", label: "Bank account", aliases: ["bank account", "bank account number", "account number"] },
  { key: "kiwiSaverStatus", label: "KiwiSaver status", aliases: ["kiwisaver status", "kiwisaver"] },
  { key: "kiwiSaverEmployeeRate", label: "KiwiSaver employee rate", aliases: ["kiwisaver employee rate", "kiwisaver rate", "kiwisaver contribution rate"] },
  { key: "studentLoan", label: "Student loan (yes/no)", aliases: ["student loan"] },
  { key: "payFrequency", label: "Pay frequency", aliases: ["pay frequency", "pay schedule", "pay period", "pay cycle"] },
  { key: "payType", label: "Pay type (salary or hourly)", aliases: ["pay type", "pay basis", "compensation type"] },
  { key: "payRate", label: "Pay rate", aliases: ["pay rate", "rate", "salary", "annual salary", "hourly rate", "compensation"] },
  { key: "payPer", label: "Paid per (year or hour)", aliases: ["paid per", "pay per", "per"] },
  { key: "hoursPerWeek", label: "Hours per week", aliases: ["hours per week", "standard hours", "ordinary hours", "weekly hours", "fte hours"] },
] as const;

export type EmployeeImportField = (typeof EMPLOYEE_IMPORT_FIELDS)[number]["key"];
const FIELD_KEYS = new Set<string>(EMPLOYEE_IMPORT_FIELDS.map((field) => field.key));

/** Values for rows without one: chosen by the person, never assumed (EMI4). */
export type EmployeeImportDefaults = Partial<Record<"taxCode" | "kiwiSaverStatus" | "kiwiSaverEmployeeRate" | "kiwiSaverEmployerRate" | "studentLoan" | "payFrequency", string>>;
const DEFAULT_KEYS = ["taxCode", "kiwiSaverStatus", "kiwiSaverEmployeeRate", "kiwiSaverEmployerRate", "studentLoan", "payFrequency"] as const;

export type EmployeeImportOutcome = { row: number; label: string; action: "create" | "skip"; detail?: string };
export type EmployeeImportResult = {
  committed: boolean;
  fileName: string;
  headings: string[];
  /** Which column (0-based) each field was read from, or null. */
  mapping: Partial<Record<EmployeeImportField, number | null>>;
  outcomes: EmployeeImportOutcome[];
  problems: Array<{ row: number; message: string }>;
  counts: { create: number; skip: number };
};

const simple = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The file's rows, as text: CSV (UTF-8 or Windows-1252) or the first sheet of an .xlsx. */
function readRows(fileName: string, fileBase64: unknown): string[][] {
  if (typeof fileBase64 !== "string" || fileBase64.length === 0) throw new ValidationError("Choose a CSV or Excel file.");
  if (fileBase64.length > Math.ceil((MAX_EMPLOYEE_IMPORT_BYTES * 4) / 3) + 4) throw new ValidationError("The file is larger than 5 MB.");
  const bytes = Buffer.from(fileBase64, "base64");
  if (bytes.length === 0) throw new ValidationError("The file is empty.");
  let rows: string[][];
  try {
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) rows = readXlsxRows(bytes);
    else if (fileName.toLowerCase().endsWith(".xls")) throw new ValidationError("Older Excel files (.xls) aren't supported. Save it as .xlsx or CSV.");
    else rows = parseDelimited(decodeText(bytes), { keepBlankRows: true });
  } catch (error) {
    if (error instanceof RowError) throw new ValidationError(error.message);
    throw error;
  }
  rows = rows.map((row) => row.map((cell) => fromCsvCell(cell ?? "")));
  while (rows.length > 0 && !rows[rows.length - 1].some((cell) => cell.trim() !== "")) rows.pop();
  if (rows.length === 0) throw new ValidationError("The file has no rows.");
  if (rows.length > MAX_EMPLOYEE_IMPORT_ROWS + 20) throw new ValidationError(`The file has more than ${MAX_EMPLOYEE_IMPORT_ROWS} rows.`);
  return rows;
}

/** The headings row: the first of the top 20 with the most headings Tohyee knows (at least two). */
function headerRowOf(rows: string[][]): number {
  let best = 0;
  let bestCount = 1;
  rows.slice(0, 20).forEach((row, index) => {
    const count = row.filter((cell) => EMPLOYEE_IMPORT_FIELDS.some((field) => (field.aliases as readonly string[]).includes(simple(cell)))).length;
    if (count > bestCount) {
      best = index;
      bestCount = count;
    }
  });
  return best;
}

/** Each field's column, from its heading (EMI2): the first alias that matches wins, and a column is used once. */
export function guessMapping(headings: string[]): Partial<Record<EmployeeImportField, number | null>> {
  const used = new Set<number>();
  const mapping: Partial<Record<EmployeeImportField, number | null>> = {};
  const names = headings.map(simple);
  for (const field of EMPLOYEE_IMPORT_FIELDS) {
    let found: number | null = null;
    for (const alias of field.aliases) {
      const at = names.findIndex((name, index) => name === alias && !used.has(index));
      if (at >= 0) {
        found = at;
        break;
      }
    }
    if (found !== null) used.add(found);
    mapping[field.key] = found;
  }
  return mapping;
}

function parseMapping(input: unknown, headings: string[]): Partial<Record<EmployeeImportField, number | null>> {
  if (input === undefined || input === null) return guessMapping(headings);
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError("mapping must be an object.");
  const mapping: Partial<Record<EmployeeImportField, number | null>> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!FIELD_KEYS.has(key)) throw new ValidationError(`${key} isn't a field Tohyee brings in.`);
    if (value === null || value === "") mapping[key as EmployeeImportField] = null;
    else if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < headings.length) mapping[key as EmployeeImportField] = value;
    else throw new ValidationError(`The column for ${key} isn't in the file.`);
  }
  return mapping;
}

/** "Fortnightly", "Every other week", "Bi-weekly" → fortnightly (EMI5). Twice a month isn't a New Zealand pay frequency Tohyee has. */
export function payFrequencyOf(text: string): string {
  const value = simple(text);
  if (/^(weekly|week|every week|1 week)$/.test(value)) return "weekly";
  if (/^(fortnightly|fortnight|bi weekly|biweekly|every other week|every 2 weeks|every two weeks|2 weekly)$/.test(value)) return "fortnightly";
  if (/^(four weekly|4 weekly|every 4 weeks|every four weeks)$/.test(value)) return "four_weekly";
  if (/^(monthly|month|every month)$/.test(value)) return "monthly";
  throw new ValidationError(`Pay frequency "${text}" isn't weekly, fortnightly, four-weekly or monthly.`);
}

function kiwiSaverStatusOf(text: string): string {
  const value = simple(text).replace(/ /g, "_");
  const words: Record<string, string> = { yes: "enrolled", member: "enrolled", no: "not_enrolled", not_a_member: "not_enrolled", opted_out: "opted_out", savings_suspension: "savings_suspension", not_eligible: "not_eligible" };
  const status = (KIWI_SAVER_STATUSES as readonly string[]).includes(value) ? value : words[value];
  if (!status) throw new ValidationError(`KiwiSaver status "${text}" isn't enrolled, not enrolled, opted out, savings suspension or not eligible.`);
  return status;
}

/** "3.5%", "3.5" → 3.5. */
const rateOf = (text: string, field: string) => number(text.replace(/%\s*$/, ""), field, 2);

/** A pay rate as HR systems write it: "$52,000.00", "52000.00 NZD", "28.50 NZD" (EMI6). */
function payAmountOf(text: string, field: string): string {
  const cleaned = text.replace(/\s*[A-Z]{3}\s*$/, "").replace(/\s*(per|\/)\s*(year|annum|hour|hr)\s*$/i, "").trim();
  const amount = money(cleaned, field);
  if (amount === null) throw new ValidationError(`${field} is empty.`);
  return amount;
}

type RowInput = { label: string; email: string | null; firstName: string; lastName: string; startDate: string; input: Record<string, unknown> };

/** One row as createEmployee's input (EMI3-EMI6). Throws a ValidationError naming what's wrong. */
function rowInput(cells: string[], mapping: Partial<Record<EmployeeImportField, number | null>>, defaults: EmployeeImportDefaults, dateOrder: "dmy" | "mdy" | "ymd"): RowInput {
  const cell = (key: EmployeeImportField) => {
    const at = mapping[key];
    return at === null || at === undefined ? "" : (cells[at] ?? "").trim();
  };
  const orDefault = (key: (typeof DEFAULT_KEYS)[number], label: string) => {
    const value = (key in mapping ? cell(key as EmployeeImportField) : "") || defaults[key] || "";
    if (!value) throw new ValidationError(`${label} is missing. Add a column for it, or choose one for everyone without it.`);
    return value;
  };
  const firstName = cell("firstName");
  const lastName = cell("lastName");
  if (!firstName || !lastName) throw new ValidationError("First and last name are needed.");
  const startText = cell("startDate");
  if (!startText) throw new ValidationError("Start date is missing.");
  const startDate = date(startText, "Start date", dateOrder);
  const finishText = cell("finishDate");
  const birthText = cell("dateOfBirth");
  const irdNumber = cell("irdNumber");
  if (!irdNumber) throw new ValidationError("IRD number is missing. Every employee needs one.");

  // Pay: a salary per year, or an hourly rate with ordinary hours (EMI6).
  const typeText = simple(cell("payType"));
  const perText = simple(cell("payPer"));
  const rateText = cell("payRate");
  if (!rateText) throw new ValidationError("Pay rate is missing.");
  const hourly = /hour/.test(typeText) || /^(hour|hourly|hr)$/.test(perText) || /\b(hour|hr)\b/i.test(rateText);
  const salary = /salar/.test(typeText) || /^(year|annum|annual|yearly)$/.test(perText);
  if (hourly && salary) throw new ValidationError("Pay type and paid per disagree: one says hourly, the other a salary.");
  if (!hourly && !salary) throw new ValidationError("Pay type (salary or hourly) is missing.");
  const pay = hourly
    ? { payBasis: "hourly", hourlyRate: payAmountOf(rateText, "Pay rate"), ordinaryHoursPerWeek: cell("hoursPerWeek") ? number(cell("hoursPerWeek"), "Hours per week", 2) : undefined }
    : { payBasis: "salary", annualSalary: payAmountOf(rateText, "Pay rate") };
  if (hourly && !pay.ordinaryHoursPerWeek) throw new ValidationError("Hours per week is missing for an hourly employee.");

  const kiwiSaverStatus = kiwiSaverStatusOf(orDefault("kiwiSaverStatus", "KiwiSaver status"));
  const enrolled = kiwiSaverStatus === "enrolled";
  const studentLoanText = (cell("studentLoan") || defaults.studentLoan || "").trim();
  const email = cell("email") || null;
  return {
    label: `${firstName} ${lastName}`,
    email,
    firstName,
    lastName,
    startDate,
    input: {
      firstName,
      lastName,
      email,
      phone: cell("phone") || null,
      dateOfBirth: birthText ? date(birthText, "Date of birth", dateOrder) : null,
      startDate,
      finishDate: finishText ? date(finishText, "Finish date", dateOrder) : null,
      jobTitle: cell("jobTitle") || null,
      irdNumber,
      taxCode: orDefault("taxCode", "Tax code"),
      bankAccount: cell("bankAccount") || undefined,
      kiwiSaverStatus,
      // Rates are kept whatever the status, as when typed in; they only apply while enrolled.
      kiwiSaverEmployeeRate: rateOf(enrolled ? orDefault("kiwiSaverEmployeeRate", "KiwiSaver employee rate") : cell("kiwiSaverEmployeeRate") || defaults.kiwiSaverEmployeeRate || "3", "KiwiSaver employee rate"),
      kiwiSaverEmployerRate: rateOf(enrolled ? orDefault("kiwiSaverEmployerRate", "KiwiSaver employer rate") : defaults.kiwiSaverEmployerRate || "3", "KiwiSaver employer rate"),
      studentLoan: studentLoanText ? yesNo(studentLoanText, "Student loan") : (() => { throw new ValidationError("Student loan (yes or no) is missing. Add a column for it, or choose one for everyone without it."); })(),
      payFrequency: payFrequencyOf(orDefault("payFrequency", "Pay frequency")),
      ...pay,
    },
  };
}

function parseDefaults(input: unknown): EmployeeImportDefaults {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError("defaults must be an object.");
  const defaults: EmployeeImportDefaults = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(DEFAULT_KEYS as readonly string[]).includes(key)) throw new ValidationError(`${key} can't be given for everyone.`);
    const text = optionalString(value, key, { maxLength: 40 });
    if (text) defaults[key as (typeof DEFAULT_KEYS)[number]] = text;
  }
  return defaults;
}

/**
 * Previews or brings in employees from a file (EMI1-EMI8). With `commit`
 * false, or any problem, nothing is saved.
 */
export async function importEmployees(tx: OrgTx, input: Record<string, unknown>, commit: boolean): Promise<EmployeeImportResult> {
  await requirePayrollAccess(tx);
  const fileName = optionalString(input.fileName, "fileName", { maxLength: 255 }) ?? "file";
  const idempotencyKey = commit ? requireIdempotencyKey(input.idempotencyKey) : null;
  const rows = readRows(fileName, input.fileBase64);
  const headerRow = headerRowOf(rows);
  const headings = (rows[headerRow] ?? []).map((cell) => cell.trim());
  const mapping = parseMapping(input.mapping, headings);
  const defaults = parseDefaults(input.defaults);
  const dateOrder = input.dateOrder === "mdy" || input.dateOrder === "ymd" ? input.dateOrder : "dmy";
  for (const required of ["firstName", "lastName", "startDate"] as const) {
    if (mapping[required] === null || mapping[required] === undefined) {
      const label = EMPLOYEE_IMPORT_FIELDS.find((field) => field.key === required)!.label;
      return { committed: false, fileName, headings, mapping, outcomes: [], problems: [{ row: headerRow + 1, message: `No column is matched to ${label}. Choose one.` }], counts: { create: 0, skip: 0 } };
    }
  }

  // Already here (EMI7): the same email, or the same name and start date.
  const existing = await tx.query<{ first_name: string; last_name: string; email: string | null; start_date: string }>(
    "select first_name, last_name, email, start_date::text from payroll_employees",
  );
  const known = new Set(existing.rows.map((row) => `${simple(row.first_name)}|${simple(row.last_name)}|${row.start_date}`));
  const knownEmails = new Set(existing.rows.filter((row) => row.email).map((row) => row.email!.toLowerCase()));

  const outcomes: EmployeeImportOutcome[] = [];
  const problems: Array<{ row: number; message: string }> = [];
  await tx.query("savepoint employee_import");
  for (let index = headerRow + 1; index < rows.length; index += 1) {
    const cells = rows[index];
    if (!cells.some((value) => value.trim() !== "")) continue;
    const row = index + 1;
    let parsed: RowInput;
    try {
      parsed = rowInput(cells, mapping, defaults, dateOrder);
    } catch (error) {
      if (error instanceof ValidationError) {
        problems.push({ row, message: error.message });
        continue;
      }
      throw error;
    }
    const key = `${simple(parsed.firstName)}|${simple(parsed.lastName)}|${parsed.startDate}`;
    if (known.has(key) || (parsed.email && knownEmails.has(parsed.email.toLowerCase()))) {
      outcomes.push({ row, label: parsed.label, action: "skip", detail: "Already an employee here" });
      continue;
    }
    await tx.query("savepoint employee_import_row");
    try {
      await createEmployee(tx, { ...parsed.input, idempotencyKey: `${idempotencyKey ?? "preview"}:${row}` });
      await tx.query("release savepoint employee_import_row");
      outcomes.push({ row, label: parsed.label, action: "create" });
      known.add(key);
      if (parsed.email) knownEmails.add(parsed.email.toLowerCase());
    } catch (error) {
      await tx.query("rollback to savepoint employee_import_row");
      if (error instanceof HttpError) problems.push({ row, message: error.message });
      else throw error;
    }
  }
  const counts = { create: outcomes.filter((entry) => entry.action === "create").length, skip: outcomes.filter((entry) => entry.action === "skip").length };
  const committed = commit && problems.length === 0 && counts.create > 0;
  if (!committed) {
    await tx.query("rollback to savepoint employee_import");
  } else {
    await writeAuditEvent(tx, { eventType: "payroll_employees.imported", entityType: "payroll_employees", entityId: tx.organisationId, details: { fileName, created: counts.create, skipped: counts.skip } });
  }
  return { committed, fileName, headings, mapping, outcomes, problems, counts };
}
