import { writeAuditEvent } from "@/lib/audit";
import { RECEIVABLES_SQL, dueDateFromTerms } from "@/lib/customers/service";
import { todayIsoDate, parseOptionalIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { exchangeRateFor } from "@/lib/fx/documents";
import { type BalanceChange, type FeePart, addDays, chargeable, interestFor, splitFee } from "@/lib/invoices/late-fee-rules";
import { approveInvoice, createInvoice, loadSalesLines } from "@/lib/invoices/service";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, divide, isPositive, parseDecimalInput, sum, toFixedString } from "@/lib/money/decimal";
import { getGstRegistration, isRegisteredOn } from "@/lib/tax/registration";

/**
 * Late payment fees and interest (LATE1-LATE12, docs/ACCOUNTING-EXAMPLES.md).
 * Off until an admin turns it on. Each overdue invoice that's charged gets a
 * new invoice to the same customer: the fee (GST like the sale) and interest
 * (exempt), recorded in late_fee_charges so nothing is charged twice. The
 * overdue invoice itself is never changed.
 */

export type LateFeeSettings = {
  enabled: boolean;
  feeAmount: string | null;
  interestRate: string | null;
  graceDays: number;
  minimumOverdue: string;
  feeAccountCode: string | null;
  interestAccountCode: string | null;
  approve: boolean;
  monthly: boolean;
  lastMonthlyRun: string | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

type SettingsRow = {
  enabled: boolean;
  fee_amount: string | null;
  interest_rate: string | null;
  grace_days: number;
  minimum_overdue: string;
  fee_account_code: string | null;
  interest_account_code: string | null;
  approve: boolean;
  monthly: boolean;
  last_monthly_run: string | null;
  updated_at: Date | string | null;
  updated_by_email: string | null;
};

/** LATE1: the defaults offered for the two accounts: Other revenue and Interest income, or the first of each type. */
async function defaultAccounts(tx: OrgTx): Promise<{ fee: string | null; interest: string | null }> {
  const pick = async (types: string[], preferred: string) =>
    (
      await tx.query<{ code: string }>(
        `select code from accounts where is_active and account_type = any($1::text[])
          order by (lower(name) = $2) desc, (lower(name) like '%' || $2 || '%') desc, code limit 1`,
        [types, preferred],
      )
    ).rows[0]?.code ?? null;
  return { fee: await pick(["revenue"], "other revenue"), interest: await pick(["other_income"], "interest income") };
}

export async function getLateFeeSettings(tx: OrgTx): Promise<LateFeeSettings> {
  const found = await tx.query<SettingsRow>(
    `select s.enabled, s.fee_amount::text, s.interest_rate::text, s.grace_days, s.minimum_overdue::text,
            fa.code as fee_account_code, ia.code as interest_account_code, s.approve, s.monthly,
            s.last_monthly_run::text, s.updated_at, s.updated_by_email
       from late_fee_settings s
       left join accounts fa on fa.id = s.fee_account_id
       left join accounts ia on ia.id = s.interest_account_id`,
  );
  const row = found.rows[0];
  const defaults = await defaultAccounts(tx);
  if (!row) {
    return {
      enabled: false, feeAmount: null, interestRate: null, graceDays: 7, minimumOverdue: "0.00",
      feeAccountCode: defaults.fee, interestAccountCode: defaults.interest, approve: false, monthly: false,
      lastMonthlyRun: null, updatedAt: null, updatedByEmail: null,
    };
  }
  return {
    enabled: row.enabled,
    feeAmount: row.fee_amount,
    interestRate: row.interest_rate === null ? null : trimRate(row.interest_rate),
    graceDays: row.grace_days,
    minimumOverdue: row.minimum_overdue,
    feeAccountCode: row.fee_account_code ?? defaults.fee,
    interestAccountCode: row.interest_account_code ?? defaults.interest,
    approve: row.approve,
    monthly: row.monthly,
    lastMonthlyRun: row.last_monthly_run,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedByEmail: row.updated_by_email,
  };
}

function trimRate(rate: string): string {
  return rate.includes(".") ? rate.replace(/0+$/, "").replace(/\.$/, "") : rate;
}

function optionalAmount(input: unknown, label: string, options: { allowZero?: boolean; maxScale?: number } = {}): string | null {
  if (input === null || input === undefined || (typeof input === "string" && input.trim() === "")) return null;
  return parseDecimalInput(input, label, { maxScale: options.maxScale ?? 2, allowZero: options.allowZero });
}

async function accountId(tx: OrgTx, code: unknown, types: string[], label: string): Promise<string | null> {
  if (code === null || code === undefined || code === "") return null;
  if (typeof code !== "string") throw new ValidationError(`${label} must be an account code.`);
  const found = await tx.query<{ id: string; account_type: string; is_active: boolean }>(
    "select id, account_type, is_active from accounts where code = $1",
    [code.trim()],
  );
  const account = found.rows[0];
  if (!account || !account.is_active) throw new ValidationError(`${label}: there's no active account ${code}.`);
  if (!types.includes(account.account_type)) {
    throw new ValidationError(`${label}: account ${code} isn't ${types.includes("other_income") ? "an income or other income" : "a sales"} account.`);
  }
  return account.id;
}

/**
 * LATE1, LATE10: an admin's settings. Turning it on needs a fee or a rate,
 * and an account for each. When the monthly run starts (monthly ticked with
 * late fees on, where it wasn't before), the current month counts as done,
 * so the first run is on the 1st of next month, not within the hour (LATE13).
 */
export async function saveLateFeeSettings(tx: OrgTx, input: Record<string, unknown>, today: string = todayIsoDate()): Promise<LateFeeSettings> {
  const enabled = input.enabled === true;
  const feeAmount = optionalAmount(input.feeAmount, "The fee");
  const interestRate = optionalAmount(input.interestRate, "The interest rate", { maxScale: 4 });
  if (interestRate !== null && cmp(dec(interestRate), dec("100")) > 0) {
    throw new ValidationError("The interest rate is a percent a year, up to 100.");
  }
  const graceDays = input.graceDays === undefined || input.graceDays === null || input.graceDays === "" ? 0 : Number(input.graceDays);
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 365) throw new ValidationError("Days of grace must be a whole number from 0 to 365.");
  const minimumOverdue = optionalAmount(input.minimumOverdue, "The minimum", { allowZero: true }) ?? "0.00";
  // Left out, the accounts offered by default (LATE1).
  const defaults = await defaultAccounts(tx);
  const feeAccountId = await accountId(tx, input.feeAccountCode === undefined ? defaults.fee : input.feeAccountCode, ["revenue"], "The fee's account");
  const interestAccountId = await accountId(
    tx,
    input.interestAccountCode === undefined ? defaults.interest : input.interestAccountCode,
    ["other_income", "revenue"],
    "The interest's account",
  );
  if (enabled) {
    if (feeAmount === null && interestRate === null) throw new ValidationError("To turn late fees on, set a fee, an interest rate or both.");
    if (feeAmount !== null && feeAccountId === null) throw new ValidationError("Choose the account the fee goes to.");
    if (interestRate !== null && interestAccountId === null) throw new ValidationError("Choose the account the interest goes to.");
  }
  const before = (await tx.query<{ running: boolean }>("select (enabled and monthly) as running from late_fee_settings for update")).rows[0];
  const starting = enabled && input.monthly === true && !before?.running;
  await tx.query(
    `insert into late_fee_settings (id, enabled, fee_amount, interest_rate, grace_days, minimum_overdue, fee_account_id,
                                    interest_account_id, approve, monthly, updated_at, updated_by_email)
     values (true, $1, $2::numeric, $3::numeric, $4, $5::numeric, $6, $7, $8, $9, now(), $10)
     on conflict (id) do update set enabled = excluded.enabled, fee_amount = excluded.fee_amount,
       interest_rate = excluded.interest_rate, grace_days = excluded.grace_days, minimum_overdue = excluded.minimum_overdue,
       fee_account_id = excluded.fee_account_id, interest_account_id = excluded.interest_account_id,
       approve = excluded.approve, monthly = excluded.monthly, updated_at = now(), updated_by_email = excluded.updated_by_email`,
    [enabled, feeAmount, interestRate, graceDays, minimumOverdue, feeAccountId, interestAccountId, input.approve === true, input.monthly === true, tx.actor.email],
  );
  if (starting) await tx.query("update late_fee_settings set last_monthly_run = $1", [`${today.slice(0, 7)}-01`]);
  await writeAuditEvent(tx, {
    eventType: "late_fees.settings_saved",
    entityType: "late_fee_settings",
    entityId: "late_fees",
    details: { enabled, feeAmount, interestRate, graceDays, minimumOverdue, approve: input.approve === true, monthly: input.monthly === true },
  });
  return getLateFeeSettings(tx);
}

export type LateFeeExclusion = { contactId: string; name: string; addedAt: string; addedByEmail: string | null };

/** LATE11: customers who are never charged. */
export async function listLateFeeExclusions(tx: OrgTx): Promise<LateFeeExclusion[]> {
  const found = await tx.query<{ contact_id: string; name: string; added_at: Date | string; added_by_email: string | null }>(
    "select e.contact_id, c.name, e.added_at, e.added_by_email from late_fee_exclusions e join contacts c on c.id = e.contact_id order by c.name",
  );
  return found.rows.map((row) => ({ contactId: row.contact_id, name: row.name, addedAt: new Date(row.added_at).toISOString(), addedByEmail: row.added_by_email }));
}

export async function setLateFeeExclusion(tx: OrgTx, contactIdInput: unknown, excluded: boolean): Promise<LateFeeExclusion[]> {
  const contactId = typeof contactIdInput === "string" || typeof contactIdInput === "number" ? String(contactIdInput) : "";
  if (!/^\d+$/.test(contactId)) throw new ValidationError("contactId is required.");
  const contact = await tx.query("select 1 from contacts where id = $1", [contactId]);
  if (!contact.rowCount) throw new ValidationError("There's no such contact.");
  if (excluded) {
    await tx.query("insert into late_fee_exclusions (contact_id, added_by_email) values ($1, $2) on conflict do nothing", [contactId, tx.actor.email]);
  } else {
    await tx.query("delete from late_fee_exclusions where contact_id = $1", [contactId]);
  }
  await writeAuditEvent(tx, {
    eventType: excluded ? "late_fees.customer_excluded" : "late_fees.customer_included",
    entityType: "contact",
    entityId: contactId,
    details: {},
  });
  return listLateFeeExclusions(tx);
}

export type LateFeeLine = { description: string; amount: string; taxCode: string | null; accountCode: string };

export type LateFeeDue = {
  invoiceId: string;
  invoiceNumber: string | null;
  contactId: string;
  contactName: string;
  dueDate: string;
  amountDue: string;
  currencyCode: string;
  /** LATE12: for an invoice in another currency, the rate (base currency per 1 unit) the fee and minimum were converted at; else null. */
  exchangeRate: string | null;
  fee: FeePart[];
  /** The fee before GST, all parts together; null with no fee. */
  feeTotal: string | null;
  interest: { from: string; to: string; days: number; rate: string; amount: string } | null;
  total: string;
  lines: LateFeeLine[];
};

type OpenInvoice = {
  id: string;
  invoice_number: string | null;
  contact_id: string;
  contact_name: string;
  due_date: string;
  amount_due: string;
  currency_code: string;
  total: string;
};

/** LATE7: what's changed what's owing on an invoice, by date: payments, credit and overpayments used, and their undoing. */
async function balanceChanges(tx: OrgTx, invoiceId: string): Promise<BalanceChange[]> {
  const found = await tx.query<{ date: string; amount: string }>(
    `select payment_date::text as date, (-(amount - overpayment_amount))::text as amount from customer_payments where invoice_id = $1
     union all select void_date::text, (amount - overpayment_amount)::text from customer_payments where invoice_id = $1 and void_date is not null
     union all select application_date::text, (-amount)::text from sales_credit_note_applications where invoice_id = $1
     union all select removal_date::text, amount::text from sales_credit_note_applications where invoice_id = $1 and removal_date is not null
     union all select application_date::text, (-amount)::text from customer_overpayment_applications where invoice_id = $1
     union all select removal_date::text, amount::text from customer_overpayment_applications where invoice_id = $1 and removal_date is not null`,
    [invoiceId],
  );
  return found.rows;
}

const DATE_LABEL = new Intl.DateTimeFormat("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function dateLabel(date: string): string {
  return DATE_LABEL.format(new Date(`${date}T00:00:00Z`));
}

async function codeOfCategory(tx: OrgTx, category: string, preferred: string): Promise<string | null> {
  const found = await tx.query<{ code: string }>(
    "select code from tax_codes where category = $1 and is_active order by (code = $2) desc, code limit 1",
    [category, preferred],
  );
  return found.rows[0]?.code ?? null;
}

/** An overdue invoice that would be charged but can't be (LATE12: no exchange rate), and why. */
export type LateFeeCannot = { invoiceId: string; invoiceNumber: string | null; contactName: string; currencyCode: string; reason: string };

/**
 * LATE12: the fee and the minimum are set in the base currency. For an
 * invoice in another currency they're converted at the rate for the charge
 * date (base currency per 1 unit), rounded half up to the currency's
 * smallest unit. Null fields need no conversion; a string is why it can't.
 */
async function inInvoiceCurrency(
  tx: OrgTx,
  input: { currencyCode: string; asOf: string; scale: number; fee: string | null; minimum: string },
): Promise<{ rate: string | null; fee: string | null; minimum: string } | string> {
  if (input.currencyCode === tx.baseCurrency) return { rate: null, fee: input.fee, minimum: input.minimum };
  if (input.fee === null && !isPositive(dec(input.minimum))) return { rate: null, fee: null, minimum: input.minimum };
  let rate: string | null = null;
  try {
    rate = await exchangeRateFor(tx, { currencyCode: input.currencyCode, date: input.asOf, typed: undefined, what: "late payment invoice" });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
  }
  if (!rate || !isPositive(dec(rate))) {
    const what = input.fee !== null ? `the ${tx.baseCurrency} ${input.fee} fee` : `the ${tx.baseCurrency} ${input.minimum} minimum`;
    return `There's no ${input.currencyCode} exchange rate for ${dateLabel(input.asOf)}, so ${what} can't be worked out in ${input.currencyCode}. Add a rate under Accounting › Exchange rates, then charge it again.`;
  }
  const convert = (amount: string) => toFixedString(divide(dec(amount), dec(rate), input.scale), input.scale);
  return { rate, fee: input.fee === null ? null : convert(input.fee), minimum: convert(input.minimum) };
}

/**
 * LATE2-LATE12: what's due to be charged on `asOf`, invoice by invoice
 * (or only `invoiceIds`). Charges nothing. `cannotCharge` lists invoices
 * that would be charged but can't be, with why (LATE12).
 */
export async function lateFeesDue(
  tx: OrgTx,
  input: { asOf?: unknown; invoiceIds?: readonly string[] } = {},
): Promise<{ asOf: string; settings: LateFeeSettings; due: LateFeeDue[]; cannotCharge: LateFeeCannot[] }> {
  const asOf = parseOptionalIsoDate(input.asOf, "asOf") ?? todayIsoDate();
  const settings = await getLateFeeSettings(tx);
  if (!settings.enabled) return { asOf, settings, due: [], cannotCharge: [] };
  const open = await tx.query<OpenInvoice>(
    `${RECEIVABLES_SQL}
     select i.id, i.invoice_number, i.contact_id, c.name as contact_name, i.due_date::text, i.amount_due::text, i.currency_code, s.total::text
       from invoices i
       join sales_invoices s on s.id = i.id and s.status = 'approved'
       join contacts c on c.id = i.contact_id
      where i.amount_due > 0 and i.due_date < $1::date
        and not exists (select 1 from late_fee_exclusions e where e.contact_id = i.contact_id)
        -- No charge on a late payment invoice (LATE6), unless the one it came from was voided.
        and not exists (select 1 from late_fee_charges lc where lc.charge_invoice_id = i.id)
        and ($2::bigint[] is null or i.id = any($2::bigint[]))
      order by i.due_date, i.id`,
    [asOf, input.invoiceIds ? [...input.invoiceIds] : null],
  );
  const registration = await getGstRegistration(tx);
  const registered = isRegisteredOn(registration, asOf);
  const noGst = await codeOfCategory(tx, "out_of_scope", "NONE");
  const exempt = registered ? await codeOfCategory(tx, "exempt", "EXEMPT") : noGst;
  const due: LateFeeDue[] = [];
  const cannotCharge: LateFeeCannot[] = [];
  for (const invoice of open.rows) {
    const overdue = { dueDate: invoice.due_date, amountDue: invoice.amount_due };
    // Grace first; the minimum is compared in the invoice's own currency below (LATE12).
    if (!chargeable({ ...settings, minimumOverdue: "0" }, overdue, asOf)) continue;
    const scale = currencyMinorUnits(invoice.currency_code);
    const earlier = await tx.query<{ kind: string; to_date: string | null }>(
      `select lc.kind, lc.to_date::text from late_fee_charges lc join sales_invoices ci on ci.id = lc.charge_invoice_id
        where lc.invoice_id = $1 and ci.status <> 'voided'`,
      [invoice.id],
    );
    const feeDue = settings.feeAmount && settings.feeAccountCode && !earlier.rows.some((row) => row.kind === "fee") ? settings.feeAmount : null;
    const converted = await inInvoiceCurrency(tx, { currencyCode: invoice.currency_code, asOf, scale, fee: feeDue, minimum: settings.minimumOverdue });
    if (typeof converted === "string") {
      cannotCharge.push({ invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, contactName: invoice.contact_name, currencyCode: invoice.currency_code, reason: converted });
      continue;
    }
    if (!chargeable({ ...settings, minimumOverdue: converted.minimum }, overdue, asOf)) continue;
    const lines: LateFeeLine[] = [];
    const label = invoice.invoice_number ?? `invoice ${invoice.id}`;
    // LATE4-LATE5: the fee, once, with GST like the sale.
    let fee: FeePart[] = [];
    if (converted.fee !== null && settings.feeAccountCode) {
      const saleLines = (await loadSalesLines(tx, "sales_invoice_lines", invoice.id)).map((line) => ({ taxCode: line.taxCode, net: line.netAmount }));
      fee = registered ? splitFee(converted.fee, saleLines, scale, noGst) : [{ taxCode: noGst, amount: toFixedString(dec(converted.fee), scale) }];
      // A part of a sale that had no tax code (it charged no GST) charges none.
      fee = fee.map((part) => ({ ...part, taxCode: part.taxCode ?? noGst }));
      for (const part of fee) {
        lines.push({
          description: `Late payment fee on ${label} (due ${dateLabel(invoice.due_date)})`,
          amount: part.amount,
          taxCode: part.taxCode,
          accountCode: settings.feeAccountCode,
        });
      }
    }
    // LATE6-LATE8: interest from the day after the due date, or after the last day charged.
    let interest: LateFeeDue["interest"] = null;
    if (settings.interestRate && settings.interestAccountCode) {
      const lastTo = earlier.rows.filter((row) => row.kind === "interest" && row.to_date).map((row) => row.to_date as string).sort().at(-1) ?? null;
      const from = addDays(lastTo ?? invoice.due_date, 1);
      if (from <= asOf) {
        const worked = interestFor({ owing: invoice.total, changes: await balanceChanges(tx, invoice.id), from, to: asOf, ratePercent: settings.interestRate, scale });
        if (isPositive(dec(worked.amount))) {
          interest = { from, to: asOf, days: worked.days, rate: settings.interestRate, amount: worked.amount };
          lines.push({
            description: `Interest at ${settings.interestRate}% a year on ${label}, ${dateLabel(from)} to ${dateLabel(asOf)} (${worked.days} ${worked.days === 1 ? "day" : "days"})`,
            amount: worked.amount,
            taxCode: exempt,
            accountCode: settings.interestAccountCode,
          });
        }
      }
    }
    if (!lines.length) continue;
    due.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      contactId: invoice.contact_id,
      contactName: invoice.contact_name,
      dueDate: invoice.due_date,
      amountDue: invoice.amount_due,
      currencyCode: invoice.currency_code,
      exchangeRate: converted.rate,
      fee,
      feeTotal: fee.length ? toFixedString(sum(fee.map((part) => dec(part.amount))), scale) : null,
      interest,
      total: toFixedString(sum(lines.map((line) => dec(line.amount))), scale),
      lines,
    });
  }
  return { asOf, settings, due, cannotCharge };
}

export type LateFeeResult = {
  asOf: string;
  charged: Array<{ invoiceId: string; invoiceNumber: string | null; chargeInvoiceId: string; chargeInvoiceNumber: string | null; status: string; total: string }>;
  failed: Array<{ invoiceId: string; invoiceNumber: string | null; reason: string }>;
};

/**
 * LATE3, LATE9, LATE10: makes the late payment invoices for what's due on
 * `asOf` (or only `invoiceIds`), each in its own savepoint so one that
 * can't be made doesn't stop the rest. Drafts unless the settings say to
 * approve them.
 */
export async function chargeLateFees(tx: OrgTx, input: { asOf?: unknown; invoiceIds?: unknown; source?: string } = {}): Promise<LateFeeResult> {
  const ids = Array.isArray(input.invoiceIds) ? input.invoiceIds.map((id) => String(id)).filter((id) => /^\d+$/.test(id)) : undefined;
  const { asOf, settings, due, cannotCharge } = await lateFeesDue(tx, { asOf: input.asOf, invoiceIds: ids });
  if (!settings.enabled) throw new ValidationError("Late fees are off. Turn them on in their settings first.");
  const source = input.source ?? "late-fees";
  // LATE12: an invoice with no exchange rate to convert the fee is reported; the rest carry on.
  const result: LateFeeResult = { asOf, charged: [], failed: cannotCharge.map((item) => ({ invoiceId: item.invoiceId, invoiceNumber: item.invoiceNumber, reason: item.reason })) };
  for (const item of due) {
    await tx.query("savepoint late_fee");
    try {
      // A voided charge's days and fee can be charged again (LATE9): its key differs.
      const voided = (await tx.query<{ n: string }>(
        `select count(distinct lc.charge_invoice_id)::text as n from late_fee_charges lc join sales_invoices ci on ci.id = lc.charge_invoice_id
          where lc.invoice_id = $1 and ci.status = 'voided'`,
        [item.invoiceId],
      )).rows[0].n;
      const key = `late-fees-${item.invoiceId}-${asOf}-${voided}`;
      const dueDate = (await dueDateFromTerms(tx, item.contactId, asOf)) ?? asOf;
      const made = await createInvoice(
        tx,
        {
          source,
          idempotencyKey: key,
          contactId: item.contactId,
          invoiceDate: asOf,
          dueDate,
          reference: `Late payment on ${item.invoiceNumber ?? `invoice ${item.invoiceId}`}`,
          amountsMode: "exclusive",
          lines: item.lines.map((line) => ({ description: line.description, quantity: "1", unitPrice: line.amount, accountCode: line.accountCode, taxCode: line.taxCode })),
        },
        { foreignCurrency: true, feature: "Late fees" },
      );
      const chargeInvoiceId = made.invoice.id;
      if (made.created) {
        for (const part of item.fee) {
          await tx.query("insert into late_fee_charges (invoice_id, charge_invoice_id, kind, amount) values ($1, $2, 'fee', $3::numeric)", [item.invoiceId, chargeInvoiceId, part.amount]);
        }
        if (item.interest) {
          await tx.query(
            `insert into late_fee_charges (invoice_id, charge_invoice_id, kind, from_date, to_date, rate, amount)
             values ($1, $2, 'interest', $3, $4, $5::numeric, $6::numeric)`,
            [item.invoiceId, chargeInvoiceId, item.interest.from, item.interest.to, item.interest.rate, item.interest.amount],
          );
        }
        await writeAuditEvent(tx, {
          eventType: "late_fees.charged",
          entityType: "sales_invoice",
          entityId: item.invoiceId,
          details: { chargeInvoiceId, asOf, total: item.total, fee: item.fee, interest: item.interest },
        });
      }
      let invoice = made.invoice;
      if (settings.approve && invoice.status === "draft") {
        invoice = (await approveInvoice(tx, chargeInvoiceId, { source, idempotencyKey: `${key}-approve` })).invoice;
      }
      await tx.query("release savepoint late_fee");
      result.charged.push({
        invoiceId: item.invoiceId,
        invoiceNumber: item.invoiceNumber,
        chargeInvoiceId,
        chargeInvoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        total: invoice.total,
      });
    } catch (error) {
      await tx.query("rollback to savepoint late_fee");
      result.failed.push({ invoiceId: item.invoiceId, invoiceNumber: item.invoiceNumber, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** LATE10: whether this month's run is due (it is from the 1st, once a month). */
export function monthlyRunDue(settings: Pick<LateFeeSettings, "enabled" | "monthly" | "lastMonthlyRun">, today: string): boolean {
  if (!settings.enabled || !settings.monthly) return false;
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  return settings.lastMonthlyRun === null || settings.lastMonthlyRun < firstOfMonth;
}

/** LATE10: the monthly run, charging up to today, and noting the month as done. */
export async function runMonthlyLateFees(tx: OrgTx, today: string = todayIsoDate()): Promise<LateFeeResult | null> {
  const settings = await getLateFeeSettings(tx);
  if (!monthlyRunDue(settings, today)) return null;
  const result = await chargeLateFees(tx, { asOf: today, source: "late-fees-monthly" });
  await tx.query("update late_fee_settings set last_monthly_run = $1", [`${today.slice(0, 7)}-01`]);
  await writeAuditEvent(tx, {
    eventType: "late_fees.monthly_run",
    entityType: "late_fee_settings",
    entityId: "late_fees",
    details: { asOf: today, charged: result.charged.length, failed: result.failed },
  });
  return result;
}

/** For the screen: totals of what's due, by currency. */
export function dueTotals(due: readonly LateFeeDue[]): Array<{ currencyCode: string; total: string }> {
  const totals = new Map<string, { total: ReturnType<typeof dec>; scale: number }>();
  for (const item of due) {
    const scale = currencyMinorUnits(item.currencyCode);
    const current = totals.get(item.currencyCode);
    totals.set(item.currencyCode, { total: add(current?.total ?? dec("0"), dec(item.total)), scale });
  }
  return [...totals.entries()].map(([currencyCode, value]) => ({ currencyCode, total: toFixedString(value.total, value.scale) }));
}
