import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { add, cmp, dec, type Decimal, isPositive, isZero, parseDecimalInput, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { parseIrdNumber } from "@/lib/organisations/entity-types";
import type { BeneficiaryYear } from "@/lib/tax/income/trust-return";
import type { Beneficiary } from "@/lib/tax/income/trusts";
import { isSupportedIncomeYear } from "@/lib/tax/income/rules";
import { optionalBoolean, requireId, requireOneOf, requireString } from "@/lib/validation";

/*
 * A trust's beneficiaries (TRU2) and the beneficiary income typed for each
 * income year (TRU3). Nothing here posts to the ledger.
 */

export type BeneficiaryRecord = Beneficiary & {
  /** Nine digits, for the IR6B (TRU25). */
  irdNumber: string | null;
  /** Where they're resident for tax, when not New Zealand, and their tax number there (TRU25). */
  jurisdiction: string | null;
  tin: string | null;
  archived: boolean;
  hasIncome: boolean;
};

type Row = {
  id: string;
  name: string;
  kind: "person" | "company";
  date_of_birth: string | null;
  settled_by_relative: boolean;
  disability_allowance: boolean;
  corporate_rule: boolean;
  ird_number: string | null;
  jurisdiction: string | null;
  tin: string | null;
  archived_at: string | null;
  has_income: boolean;
};

const COLUMNS = `b.id::text, b.name, b.kind, to_char(b.date_of_birth, 'YYYY-MM-DD') as date_of_birth, b.settled_by_relative, b.disability_allowance,
  b.corporate_rule, b.ird_number, b.jurisdiction, b.tin, b.archived_at, exists (select 1 from trust_beneficiary_income i where i.beneficiary_id = b.id) as has_income`;

function toRecord(row: Row): BeneficiaryRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    dateOfBirth: row.date_of_birth,
    settledByRelative: row.settled_by_relative,
    disabilityAllowance: row.disability_allowance,
    corporateRule: row.corporate_rule,
    irdNumber: row.ird_number,
    jurisdiction: row.jurisdiction,
    tin: row.tin,
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
  const ird = input.irdNumber === undefined ? before?.irdNumber ?? null : input.irdNumber === "" ? null : parseIrdNumber(input.irdNumber);
  const text = (value: unknown, previous: string | null | undefined, label: string, max: number) => {
    if (value === undefined) return previous ?? null;
    if (value === null || value === "") return null;
    const trimmed = requireString(value, label, { maxLength: max }).trim();
    return trimmed || null;
  };
  return {
    name,
    kind,
    dateOfBirth,
    irdNumber: ird,
    jurisdiction: text(input.jurisdiction, before?.jurisdiction, "jurisdiction", 100),
    tin: text(input.tin, before?.tin, "tin", 50),
    settledByRelative: optionalBoolean(input.settledByRelative, "settledByRelative") ?? before?.settledByRelative ?? true,
    disabilityAllowance: kind === "person" ? optionalBoolean(input.disabilityAllowance, "disabilityAllowance") ?? before?.disabilityAllowance ?? false : false,
    corporateRule: optionalBoolean(input.corporateRule, "corporateRule") ?? before?.corporateRule ?? true,
  };
}

/** Adds a beneficiary (TRU2). */
export async function addBeneficiary(tx: OrgTx, input: Record<string, unknown>): Promise<BeneficiaryRecord> {
  const value = parseBeneficiary(input);
  const created = await tx.query<{ id: string }>(
    `insert into trust_beneficiaries (name, kind, date_of_birth, settled_by_relative, disability_allowance, corporate_rule, updated_by_email, ird_number, jurisdiction, tin)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id::text`,
    [value.name, value.kind, value.dateOfBirth, value.settledByRelative, value.disabilityAllowance, value.corporateRule, tx.actor.email, value.irdNumber, value.jurisdiction, value.tin],
  );
  await writeAuditEvent(tx, { eventType: "income_tax.beneficiary_added", entityType: "trust_beneficiary", entityId: created.rows[0].id, details: { kind: value.kind } });
  return getBeneficiary(tx, created.rows[0].id);
}

async function getBeneficiary(tx: OrgTx, id: string): Promise<BeneficiaryRecord> {
  const found = await tx.query<Row>(`select ${COLUMNS} from trust_beneficiaries b where b.id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Beneficiary not found.");
  return toRecord(found.rows[0]);
}

/** Changes a beneficiary, or archives or restores one (`archived`) (TRU2). */
export async function updateBeneficiary(tx: OrgTx, idInput: unknown, input: Record<string, unknown>): Promise<BeneficiaryRecord> {
  const id = requireId(idInput, "beneficiaryId");
  const before = await getBeneficiary(tx, id);
  const value = parseBeneficiary(input, before);
  const archived = optionalBoolean(input.archived, "archived") ?? before.archived;
  await tx.query(
    `update trust_beneficiaries set name = $2, kind = $3, date_of_birth = $4, settled_by_relative = $5, disability_allowance = $6, corporate_rule = $7,
       archived_at = case when $8 then coalesce(archived_at, now()) else null end, updated_by_email = $9, updated_at = now(),
       ird_number = $10, jurisdiction = $11, tin = $12
     where id = $1`,
    [id, value.name, value.kind, value.dateOfBirth, value.settledByRelative, value.disabilityAllowance, value.corporateRule, archived, tx.actor.email, value.irdNumber, value.jurisdiction, value.tin],
  );
  await writeAuditEvent(tx, { eventType: "income_tax.beneficiary_updated", entityType: "trust_beneficiary", entityId: id, details: { archived } });
  return getBeneficiary(tx, id);
}

/** Deletes a beneficiary that's never had income allocated; one that has is archived instead (TRU2). */
export async function deleteBeneficiary(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "beneficiaryId");
  const before = await getBeneficiary(tx, id);
  if (before.hasIncome) throw new ValidationError(`${before.name} has had beneficiary income allocated, so they can be archived but not deleted.`);
  await tx.query("delete from trust_beneficiaries where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "income_tax.beneficiary_deleted", entityType: "trust_beneficiary", entityId: id, details: {} });
}

export type BeneficiaryIncome = {
  beneficiaryId: string;
  /** Beneficiary income allocated (TRU3). */
  amount: string;
  /** The trustee pays their tax on it (TRU18). */
  trusteePaysTax: boolean;
  /** Their other taxable income, for that tax (TRU18). */
  otherIncome: string;
  /** Taxable distribution other than beneficiary income: foreign and non-complying trusts (TRU21-TRU23). */
  taxableDistribution: string;
  /** Distributions that aren't taxable (TRU21). */
  nonTaxableDistribution: string;
  /** Taken out of their current account (TRU24). */
  withdrawn: string;
  /** Typed opening balance; null is last year's closing balance (TRU24). */
  openingBalance: string | null;
};

type IncomeRow = {
  income_year: number;
  beneficiary_id: string;
  amount: string;
  trustee_pays_tax: boolean;
  other_income: string;
  taxable_distribution: string;
  non_taxable_distribution: string;
  withdrawn: string;
  opening_balance: string | null;
};

const INCOME_COLUMNS = `income_year, beneficiary_id::text, amount::text, trustee_pays_tax, other_income::text, taxable_distribution::text,
  non_taxable_distribution::text, withdrawn::text, opening_balance::text`;

function toIncome(row: IncomeRow): BeneficiaryIncome {
  return {
    beneficiaryId: row.beneficiary_id,
    amount: toFixedString(dec(row.amount), 2),
    trusteePaysTax: row.trustee_pays_tax,
    otherIncome: toFixedString(dec(row.other_income), 2),
    taxableDistribution: toFixedString(dec(row.taxable_distribution), 2),
    nonTaxableDistribution: toFixedString(dec(row.non_taxable_distribution), 2),
    withdrawn: toFixedString(dec(row.withdrawn), 2),
    openingBalance: row.opening_balance === null ? null : toFixedString(dec(row.opening_balance), 2),
  };
}

export async function listBeneficiaryIncome(tx: OrgTx, year: number): Promise<BeneficiaryIncome[]> {
  const rows = await tx.query<IncomeRow>(`select ${INCOME_COLUMNS} from trust_beneficiary_income where income_year = $1 order by beneficiary_id`, [year]);
  return rows.rows.map(toIncome);
}

/** Each beneficiary's current account balance at the start of a year: the closing balance of the years before (TRU24). */
async function openingBalances(tx: OrgTx, year: number): Promise<Map<string, Decimal>> {
  const rows = await tx.query<IncomeRow>(`select ${INCOME_COLUMNS} from trust_beneficiary_income where income_year < $1 order by income_year, beneficiary_id`, [year]);
  const balances = new Map<string, Decimal>();
  for (const row of rows.rows.map((entry) => ({ ...toIncome(entry), year: entry.income_year }))) {
    const opening = row.openingBalance === null ? balances.get(row.beneficiaryId) ?? ZERO_DECIMAL : dec(row.openingBalance);
    const closing = sub(add(add(add(opening, dec(row.amount)), dec(row.taxableDistribution)), dec(row.nonTaxableDistribution)), dec(row.withdrawn));
    balances.set(row.beneficiaryId, closing);
  }
  return balances;
}

/** The beneficiaries and their income for a year, as the workpaper takes them (TRU3). */
export async function beneficiaryAllocations(tx: OrgTx, year: number): Promise<Array<{ beneficiary: Beneficiary; amount: ReturnType<typeof dec> }>> {
  return (await beneficiaryYears(tx, year)).filter((entry) => isPositive(entry.amount)).map((entry) => ({ beneficiary: entry.beneficiary, amount: entry.amount }));
}

/** Every beneficiary's figures for a year (TRU15-TRU25), with opening balances carried from last year. */
export async function beneficiaryYears(tx: OrgTx, year: number): Promise<BeneficiaryYear[]> {
  const everyone = new Map((await listBeneficiaries(tx, { includeArchived: true })).map((entry) => [entry.id, entry]));
  const carried = await openingBalances(tx, year);
  return (await listBeneficiaryIncome(tx, year)).flatMap((entry) => {
    const beneficiary = everyone.get(entry.beneficiaryId);
    if (!beneficiary) return [];
    return [
      {
        beneficiary,
        amount: dec(entry.amount),
        trusteePaysTax: entry.trusteePaysTax,
        otherIncome: dec(entry.otherIncome),
        taxableDistribution: dec(entry.taxableDistribution),
        nonTaxableDistribution: dec(entry.nonTaxableDistribution),
        withdrawn: dec(entry.withdrawn),
        openingBalance: entry.openingBalance === null ? carried.get(entry.beneficiaryId) ?? ZERO_DECIMAL : dec(entry.openingBalance),
      },
    ];
  });
}

/**
 * Saves a year's beneficiary income and distributions: every beneficiary's
 * line, replacing what was there; a line with nothing in it is removed (TRU3,
 * TRU18, TRU21, TRU24).
 */
export async function saveBeneficiaryIncome(tx: OrgTx, input: { incomeYear: unknown; lines: unknown }): Promise<BeneficiaryIncome[]> {
  const year = Number(input.incomeYear);
  if (!Number.isInteger(year) || !isSupportedIncomeYear(year)) throw new ValidationError("Choose an income year Tohyee works out.");
  if (!Array.isArray(input.lines)) throw new ValidationError("lines must be a list of beneficiaries and amounts.");
  const known = new Map((await listBeneficiaries(tx, { includeArchived: true })).map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const kept: BeneficiaryIncome[] = [];
  let total = ZERO_DECIMAL;
  for (const [index, raw] of input.lines.entries()) {
    const line = (raw ?? {}) as Record<string, unknown>;
    const id = requireId(line.beneficiaryId, `lines ${index + 1} beneficiaryId`);
    const who = known.get(id);
    if (!who) throw new ValidationError(`Line ${index + 1}: that beneficiary isn't on this trust's list.`);
    if (seen.has(id)) throw new ValidationError(`${who.name} is listed twice.`);
    seen.add(id);
    const amount = (value: unknown, label: string, allowNegative = false): Decimal => {
      if (value === null || value === undefined || value === "") return ZERO_DECIMAL;
      const parsed = dec(parseDecimalInput(value, `${who.name}'s ${label}`, { maxScale: 2, allowZero: true, allowNegative: true }));
      if (!allowNegative && !isZero(parsed) && !isPositive(parsed)) {
        throw new ValidationError(label === "beneficiary income" ? `${who.name}'s beneficiary income can't be negative: a trust loss can't be allocated.` : `${who.name}'s ${label} can't be negative.`);
      }
      return parsed;
    };
    const income = amount(line.amount, "beneficiary income");
    const otherIncome = amount(line.otherIncome, "other income");
    const taxable = amount(line.taxableDistribution, "taxable distribution");
    const nonTaxable = amount(line.nonTaxableDistribution, "distribution that isn't taxable");
    // A negative withdrawal is money paid back (TRU24).
    const withdrawn = amount(line.withdrawn, "withdrawals", true);
    const opening = line.openingBalance === null || line.openingBalance === undefined || line.openingBalance === "" ? null : amount(line.openingBalance, "opening balance", true);
    const trusteePaysTax = optionalBoolean(line.trusteePaysTax, `${who.name}'s trusteePaysTax`) ?? false;
    if ([income, taxable, nonTaxable, withdrawn].every(isZero) && opening === null) continue;
    total = add(total, income);
    kept.push({
      beneficiaryId: id,
      amount: toFixedString(income, 2),
      trusteePaysTax,
      otherIncome: toFixedString(otherIncome, 2),
      taxableDistribution: toFixedString(taxable, 2),
      nonTaxableDistribution: toFixedString(nonTaxable, 2),
      withdrawn: toFixedString(withdrawn, 2),
      openingBalance: opening === null ? null : toFixedString(opening, 2),
    });
  }
  await tx.query("delete from trust_beneficiary_income where income_year = $1", [year]);
  for (const line of kept) {
    await tx.query(
      `insert into trust_beneficiary_income (income_year, beneficiary_id, amount, updated_by_email, trustee_pays_tax, other_income, taxable_distribution, non_taxable_distribution, withdrawn, opening_balance)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [year, line.beneficiaryId, line.amount, tx.actor.email, line.trusteePaysTax, line.otherIncome, line.taxableDistribution, line.nonTaxableDistribution, line.withdrawn, line.openingBalance],
    );
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
