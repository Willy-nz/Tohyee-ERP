import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { cmp, dec, parseDecimalInput } from "@/lib/money/decimal";
import { financialYearEndMonth } from "@/lib/reports/financial";
import { getGstRegistration } from "@/lib/tax/registration";
import { PROVISIONAL_OPTIONS, type ProvisionalOption, RATIO_RIT_FROM, RATIO_RIT_TO } from "@/lib/tax/income/provisional-options";
import { incomeYearDates, instalmentDates, moneyText, shortDate } from "@/lib/tax/income/rules";
import { optionalString, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/*
 * The provisional tax option for each income year and the estimates under the estimation option (TXF14-TXF17).
 * Owners and admins only (the API checks, as for the rest of income tax). Choosing an option here doesn't tell IRD.
 */

export type EstimateRecord = { id: string; incomeYear: number; estimatedOn: string; amount: string; note: string | null; createdByEmail: string; createdAt: string };

export type ProvisionalOptionSetting = {
  incomeYear: number;
  option: ProvisionalOption;
  /** IRD's GST ratio, a percentage (ratio option only). */
  ratioPercent: string | null;
  estimates: EstimateRecord[];
  /** 0 until an option is saved for the year (standard). */
  version: number;
  updatedByEmail: string | null;
  updatedAt: string | null;
};

type OptionRow = { income_year: number; provisional_option: ProvisionalOption; ratio_percent: string | null; version: number; updated_by_email: string | null; updated_at: string };
type EstimateRow = { id: string; request_hash: string; income_year: number; estimated_on: string; amount: string; note: string | null; created_by_email: string; created_at: string };

const ESTIMATE_COLUMNS = "id::text, request_hash, income_year, estimated_on::text, amount::text, note, created_by_email, created_at";

const toEstimate = (row: EstimateRow): EstimateRecord => ({
  id: row.id,
  incomeYear: row.income_year,
  estimatedOn: row.estimated_on,
  amount: row.amount,
  note: row.note,
  createdByEmail: row.created_by_email,
  createdAt: new Date(row.created_at).toISOString(),
});

function requireYear(input: unknown): number {
  const value = typeof input === "string" && /^\d{4}$/.test(input.trim()) ? Number(input) : input;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2025 || value > 2100) throw new ValidationError("incomeYear must be a year from 2025.");
  return value;
}

export async function getProvisionalOption(tx: OrgTx, incomeYear: number): Promise<ProvisionalOptionSetting> {
  const row = (
    await tx.query<OptionRow>(
      "select income_year, provisional_option, ratio_percent::text, version, updated_by_email, updated_at from income_tax_provisional_options where income_year = $1",
      [incomeYear],
    )
  ).rows[0];
  const estimates = await tx.query<EstimateRow>(`select ${ESTIMATE_COLUMNS} from income_tax_provisional_estimates where income_year = $1 order by estimated_on, id`, [incomeYear]);
  return {
    incomeYear,
    option: row?.provisional_option ?? "standard",
    ratioPercent: row?.ratio_percent ?? null,
    estimates: estimates.rows.map(toEstimate),
    version: row?.version ?? 0,
    updatedByEmail: row?.updated_by_email ?? null,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
  };
}

/**
 * Why the organisation can't use the ratio option for the year, or null (TXF16; s RC 16, RC 17). Checks what Tohyee
 * knows: a 31 March balance date (the only dates checked), GST filed monthly or two-monthly, registered for GST for
 * the whole of last year, and last year's RIT from IRD within the limits when it's typed.
 */
async function ratioRefusal(tx: OrgTx, incomeYear: number): Promise<string | null> {
  const endMonth = await financialYearEndMonth(tx);
  if (endMonth !== 3) return "Tohyee has checked the ratio option's dates for a 31 March balance date only.";
  const settings = await tx.query<{ gst_period_months: number | null }>("select gst_period_months from organisation_settings where id = true");
  const months = settings.rows[0]?.gst_period_months ?? null;
  if (months !== 1 && months !== 2) return "The ratio option is only for GST filed monthly or two-monthly. Set the GST filing frequency under Settings if it's one of those.";
  const last = incomeYearDates(incomeYear - 1, endMonth);
  const registration = await getGstRegistration(tx);
  const wholeYear = registration.registered && (registration.from === null || registration.from <= last.start) && (registration.until === null || registration.until >= last.end);
  if (!wholeYear) return `The ratio option needs GST registration for the whole of the ${incomeYear - 1} income year (${shortDate(last.start)} to ${shortDate(last.end)}).`;
  const typed = await tx.query<{ assessed_rit: string | null }>("select assessed_rit::text from income_tax_years where income_year = $1", [incomeYear - 1]);
  const rit = typed.rows[0]?.assessed_rit ?? null;
  if (rit !== null && (cmp(dec(rit), RATIO_RIT_FROM) <= 0 || cmp(dec(rit), RATIO_RIT_TO) > 0)) {
    return `The ratio option needs last year's residual income tax to be more than 5,000.00 and no more than 150,000.00. IRD's figure for the ${incomeYear - 1} income year is ${moneyText(dec(rit))}.`;
  }
  return null;
}

/** Sets the provisional tax option for an income year (TXF14-TXF17). The ratio option needs IRD's ratio. */
export async function setProvisionalOption(tx: OrgTx, input: { incomeYear: unknown; option: unknown; ratioPercent?: unknown; version: unknown }): Promise<ProvisionalOptionSetting> {
  const incomeYear = requireYear(input.incomeYear);
  const option = requireOneOf(input.option, "option", PROVISIONAL_OPTIONS);
  const version = typeof input.version === "string" ? Number(input.version) : input.version;
  const before = await getProvisionalOption(tx, incomeYear);
  if (before.version !== version) throw new ConflictError(`Someone else changed the ${incomeYear} provisional tax option. Reload and try again.`);
  let ratioPercent: string | null = null;
  if (option === "ratio") {
    if (input.ratioPercent == null || input.ratioPercent === "") throw new ValidationError("Type the ratio IRD gave you for the year, as a percentage.");
    ratioPercent = parseDecimalInput(input.ratioPercent, "ratioPercent", { maxScale: 4 });
    if (cmp(dec(ratioPercent), dec("100")) >= 0) throw new ValidationError("The ratio must be more than 0% and less than 100% (s RC 16(2)(c)).");
    const refusal = await ratioRefusal(tx, incomeYear);
    if (refusal) throw new ValidationError(refusal);
  }
  await tx.query(
    `insert into income_tax_provisional_options (income_year, provisional_option, ratio_percent, updated_by_email) values ($1, $2, $3::numeric, $4)
     on conflict (income_year) do update set provisional_option = excluded.provisional_option, ratio_percent = excluded.ratio_percent,
       updated_by_email = excluded.updated_by_email, updated_at = now(), version = income_tax_provisional_options.version + 1`,
    [incomeYear, option, ratioPercent, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "income_tax.provisional_option_set",
    entityType: "income_tax_year",
    entityId: String(incomeYear),
    details: { from: { option: before.option, ratioPercent: before.ratioPercent }, to: { option, ratioPercent } },
  });
  return getProvisionalOption(tx, incomeYear);
}

/** Records an estimate of the year's RIT given to IRD (TXF15): on or before the last instalment date (s RC 7(3)). */
export async function addProvisionalEstimate(
  tx: OrgTx,
  input: { idempotencyKey: unknown; incomeYear: unknown; estimatedOn: unknown; amount: unknown; note?: unknown },
): Promise<{ created: boolean; estimate: EstimateRecord }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const hash = requestHash("income_tax_provisional_estimates", { incomeYear: input.incomeYear, estimatedOn: input.estimatedOn, amount: input.amount, note: input.note ?? null });
  const earlier = await tx.query<EstimateRow>(`select ${ESTIMATE_COLUMNS} from income_tax_provisional_estimates where idempotency_key = $1`, [idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "estimate");
    return { created: false, estimate: toEstimate(earlier.rows[0]) };
  }
  const incomeYear = requireYear(input.incomeYear);
  const setting = await getProvisionalOption(tx, incomeYear);
  if (setting.option !== "estimation") throw new ValidationError(`Choose the estimation option for the ${incomeYear} income year first.`);
  const estimatedOn = parseIsoDate(input.estimatedOn, "estimatedOn");
  const amount = parseDecimalInput(input.amount, "amount", { maxScale: 2, allowZero: true });
  const last = instalmentDates(incomeYear, 3, await financialYearEndMonth(tx)).at(-1)!;
  if (estimatedOn > last) throw new ValidationError(`An estimate can be made up to the last instalment date, ${shortDate(last)} (s RC 7(3)).`);
  const inserted = await tx.query<EstimateRow>(
    `insert into income_tax_provisional_estimates (idempotency_key, request_hash, income_year, estimated_on, amount, note, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5::numeric, $6, $7, $8) returning ${ESTIMATE_COLUMNS}`,
    [idempotencyKey, hash, incomeYear, estimatedOn, amount, optionalString(input.note, "note", { maxLength: 500 }), tx.actor.userId, tx.actor.email],
  );
  const estimate = toEstimate(inserted.rows[0]);
  await writeAuditEvent(tx, { eventType: "income_tax.provisional_estimate_added", entityType: "income_tax_year", entityId: String(incomeYear), details: { estimatedOn, amount } });
  return { created: true, estimate };
}

/** Removes an estimate typed by mistake (audited). */
export async function removeProvisionalEstimate(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = typeof idInput === "string" && /^\d+$/.test(idInput) ? idInput : null;
  if (!id) throw new NotFoundError("Estimate not found.");
  const removed = await tx.query<EstimateRow>(`delete from income_tax_provisional_estimates where id = $1 returning ${ESTIMATE_COLUMNS}`, [id]);
  const row = removed.rows[0];
  if (!row) throw new NotFoundError("Estimate not found.");
  await writeAuditEvent(tx, { eventType: "income_tax.provisional_estimate_removed", entityType: "income_tax_year", entityId: String(row.income_year), details: { estimatedOn: row.estimated_on, amount: row.amount } });
}
