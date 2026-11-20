import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { add, cmp, dec, isPositive, isZero, parseDecimalInput, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import type { Beneficiary } from "@/lib/tax/income/trusts";
import { isSupportedIncomeYear } from "@/lib/tax/income/rules";
import { optionalBoolean, requireId, requireOneOf, requireString } from "@/lib/validation";

/*
 * A trust's beneficiaries (TRT2) and the beneficiary income typed for each
 * income year (TRT3). Nothing here posts to the ledger.
 */

export type BeneficiaryRecord = Beneficiary & { archived: boolean; hasIncome: boolean };

type Row = {
  id: string;
  name: string;
  kind: "person" | "company";
  date_of_birth: string | null;
  settled_by_relative: boolean;
  disability_allowance: boolean;
  corporate_rule: boolean;
  archived_at: string | null;
  has_income: boolean;
};

const COLUMNS = `b.id::text, b.name, b.kind, to_char(b.date_of_birth, 'YYYY-MM-DD') as date_of_birth, b.settled_by_relative, b.disability_allowance,
  b.corporate_rule, b.archived_at, exists (select 1 from trust_beneficiary_income i where i.beneficiary_id = b.id) as has_income`;

function toRecord(row: Row): BeneficiaryRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    dateOfBirth: row.date_of_birth,
    settledByRelative: row.settled_by_relative,
    disabilityAllowance: row.disability_allowance,
    corporateRule: row.corporate_rule,
    archived: row.archived_at !== null,
    hasIncome: row.has_income,
  };
}

export async function listBeneficiaries(tx: OrgTx, input: { includeArchived?: boolean } = {}): Promise<BeneficiaryRecord[]> {
  const rows = await tx.query<Row>(`select ${COLUMNS} from trust_beneficiaries b ${input.includeArchived ? "" : "where b.archived_at is null"} order by lower(b.name), b.id`);
  return rows.rows.map(toRecord);
}

function parseBeneficiary(input: Record<string, unknown>, before?: BeneficiaryRecord) {
  const name = requireString(input.name ?? before?.name, "name", { maxLength: 200 }).trim();
  if (!name) throw new ValidationError("Give the beneficiary's name.");
  const kind = requireOneOf(input.kind ?? before?.kind, "kind", ["person", "company"] as const);
  const dobInput = input.dateOfBirth === undefined ? before?.dateOfBirth ?? null : input.dateOfBirth;
  const dateOfBirth = kind === "person" && dobInput !== null && dobInput !== "" ? parseIsoDate(dobInput, "dateOfBirth") : null;
  return {
    name,
    kind,
    dateOfBirth,
    settledByRelative: optionalBoolean(input.settledByRelative, "settledByRelative") ?? before?.settledByRelative ?? true,
    disabilityAllowance: kind === "person" ? optionalBoolean(input.disabilityAllowance, "disabilityAllowance") ?? before?.disabilityAllowance ?? false : false,
    corporateRule: optionalBoolean(input.corporateRule, "corporateRule") ?? before?.corporateRule ?? true,
  };
}

/** Adds a beneficiary (TRT2). */
export async function addBeneficiary(tx: OrgTx, input: Record<string, unknown>): Promise<BeneficiaryRecord> {
  const value = parseBeneficiary(input);
  const created = await tx.query<{ id: string }>(
    `insert into trust_beneficiaries (name, kind, date_of_birth, settled_by_relative, disability_allowance, corporate_rule, updated_by_email)
     values ($1, $2, $3, $4, $5, $6, $7) returning id::text`,
    [value.name, value.kind, value.dateOfBirth, value.settledByRelative, value.disabilityAllowance, value.corporateRule, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "income_tax.beneficiary_added", entityType: "trust_beneficiary", entityId: created.rows[0].id, details: { kind: value.kind } });
  return getBeneficiary(tx, created.rows[0].id);
}

async function getBeneficiary(tx: OrgTx, id: string): Promise<BeneficiaryRecord> {
  const found = await tx.query<Row>(`select ${COLUMNS} from trust_beneficiaries b where b.id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Beneficiary not found.");
  return toRecord(found.rows[0]);
}

/** Changes a beneficiary, or archives or restores one (`archived`) (TRT2). */
export async function updateBeneficiary(tx: OrgTx, idInput: unknown, input: Record<string, unknown>): Promise<BeneficiaryRecord> {
  const id = requireId(idInput, "beneficiaryId");
  const before = await getBeneficiary(tx, id);
  const value = parseBeneficiary(input, before);
  const archived = optionalBoolean(input.archived, "archived") ?? before.archived;
  await tx.query(
    `update trust_beneficiaries set name = $2, kind = $3, date_of_birth = $4, settled_by_relative = $5, disability_allowance = $6, corporate_rule = $7,
       archived_at = case when $8 then coalesce(archived_at, now()) else null end, updated_by_email = $9, updated_at = now()
     where id = $1`,
    [id, value.name, value.kind, value.dateOfBirth, value.settledByRelative, value.disabilityAllowance, value.corporateRule, archived, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "income_tax.beneficiary_updated", entityType: "trust_beneficiary", entityId: id, details: { archived } });
  return getBeneficiary(tx, id);
}

/** Deletes a beneficiary that's never had income allocated; one that has is archived instead (TRT2). */
export async function deleteBeneficiary(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "beneficiaryId");
  const before = await getBeneficiary(tx, id);
  if (before.hasIncome) throw new ValidationError(`${before.name} has had beneficiary income allocated, so they can be archived but not deleted.`);
  await tx.query("delete from trust_beneficiaries where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "income_tax.beneficiary_deleted", entityType: "trust_beneficiary", entityId: id, details: {} });
}

export type BeneficiaryIncome = { beneficiaryId: string; amount: string };

export async function listBeneficiaryIncome(tx: OrgTx, year: number): Promise<BeneficiaryIncome[]> {
  const rows = await tx.query<{ beneficiary_id: string; amount: string }>(
    "select beneficiary_id::text, amount::text from trust_beneficiary_income where income_year = $1 order by beneficiary_id",
    [year],
  );
  return rows.rows.map((row) => ({ beneficiaryId: row.beneficiary_id, amount: toFixedString(dec(row.amount), 2) }));
}

/** The beneficiaries and their income for a year, as the workpaper takes them (TRT3). */
export async function beneficiaryAllocations(tx: OrgTx, year: number): Promise<Array<{ beneficiary: Beneficiary; amount: ReturnType<typeof dec> }>> {
  const everyone = new Map((await listBeneficiaries(tx, { includeArchived: true })).map((entry) => [entry.id, entry]));
  return (await listBeneficiaryIncome(tx, year)).flatMap((entry) => {
    const beneficiary = everyone.get(entry.beneficiaryId);
    return beneficiary ? [{ beneficiary, amount: dec(entry.amount) }] : [];
  });
}

/** Saves a year's beneficiary income: every beneficiary's amount, replacing what was there; nil or blank removes it (TRT3). */
export async function saveBeneficiaryIncome(tx: OrgTx, input: { incomeYear: unknown; lines: unknown }): Promise<BeneficiaryIncome[]> {
  const year = Number(input.incomeYear);
  if (!Number.isInteger(year) || !isSupportedIncomeYear(year)) throw new ValidationError("Choose an income year Tohyee works out.");
  if (!Array.isArray(input.lines)) throw new ValidationError("lines must be a list of beneficiaries and amounts.");
  const known = new Map((await listBeneficiaries(tx, { includeArchived: true })).map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const kept: Array<{ id: string; amount: string }> = [];
  let total = ZERO_DECIMAL;
  for (const [index, raw] of input.lines.entries()) {
    const line = (raw ?? {}) as Record<string, unknown>;
    const id = requireId(line.beneficiaryId, `lines ${index + 1} beneficiaryId`);
    if (!known.has(id)) throw new ValidationError(`Line ${index + 1}: that beneficiary isn't on this trust's list.`);
    if (seen.has(id)) throw new ValidationError(`${known.get(id)!.name} is listed twice.`);
    seen.add(id);
    if (line.amount === null || line.amount === undefined || line.amount === "") continue;
    const amount = dec(parseDecimalInput(line.amount, `${known.get(id)!.name}'s beneficiary income`, { maxScale: 2, allowZero: true, allowNegative: true }));
    if (isZero(amount)) continue;
    if (!isPositive(amount)) throw new ValidationError(`${known.get(id)!.name}'s beneficiary income can't be negative: a trust loss can't be allocated.`);
    total = add(total, amount);
    kept.push({ id, amount: toFixedString(amount, 2) });
  }
  await tx.query("delete from trust_beneficiary_income where income_year = $1", [year]);
  for (const line of kept) {
    await tx.query("insert into trust_beneficiary_income (income_year, beneficiary_id, amount, updated_by_email) values ($1, $2, $3, $4)", [year, line.id, line.amount, tx.actor.email]);
  }
  await writeAuditEvent(tx, {
    eventType: "income_tax.beneficiary_income_saved",
    entityType: "income_tax_year",
    entityId: String(year),
    details: { beneficiaries: kept.length, total: toFixedString(total, 2) },
  });
  return listBeneficiaryIncome(tx, year);
}

/** Whether a year has more allocated than nil (for checks). */
export function anyAllocated(lines: BeneficiaryIncome[]): boolean {
  return lines.some((line) => cmp(dec(line.amount), ZERO_DECIMAL) > 0);
}
