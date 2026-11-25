import { createAccount } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import { loadCustomFieldContext, parseCustomInput, resolveCustomValues } from "@/lib/custom-fields/service";
import type { CustomValues } from "@/lib/custom-fields/values";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { dec, isZero, neg, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  addMonths,
  catchUp,
  endEarly,
  SPREAD_KIND_LABELS,
  SPREAD_KINDS,
  SPREAD_METHODS,
  type SpreadKind,
  type SpreadMethod,
  type SpreadMonth,
  spreadSchedule,
} from "@/lib/spreading/rules";
import { loadSourceLine, postMove, reverseMove, type SourceKind, type SourceLine, sourceLabel } from "@/lib/spreading/sources";
import { checkNewTags, loadTrackingContext, parseTrackingInput, sortedTags, type TrackingTags } from "@/lib/tracking/service";
import { asRecord, optionalId, optionalSource, requireArray, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * The Spreading worksheet's records (examples SW1-SW14): the account each
 * kind is held in, the items being spread and each month's amount. Posting a
 * month is in `runs.ts`; the sums are in `rules.ts`.
 *
 * In this version the bill or invoice is coded to the kind's balance sheet
 * account by the person, and the item is added here. The worksheet then says
 * whether what it holds matches that account (SW11).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

/** A kind's account in spreading_settings, and what a fresh one is called. */
const HOLDING: Record<SpreadKind, { column: string; accountType: "current_asset" | "current_liability"; name: string; codes: string[] }> = {
  prepayment: { column: "prepayment_account_id", accountType: "current_asset", name: "Prepayments", codes: ["1200", "1205", "1206", "1207"] },
  accrued_income: { column: "accrued_income_account_id", accountType: "current_asset", name: "Accrued income", codes: ["1210", "1215", "1216", "1217"] },
  income_in_advance: { column: "income_in_advance_account_id", accountType: "current_liability", name: "Income in advance", codes: ["2500", "2505", "2506", "2507"] },
  accrued_expense: { column: "accrued_expense_account_id", accountType: "current_liability", name: "Accrued expenses", codes: ["2510", "2515", "2516", "2517"] },
};

/** Costs land on an expense account; income on a revenue account. */
const TARGET_CLASS: Record<SpreadKind, "expense" | "revenue"> = {
  prepayment: "expense",
  accrued_expense: "expense",
  income_in_advance: "revenue",
  accrued_income: "revenue",
};

export type SpreadAccount = { id: string; code: string; name: string };
export type SpreadingSettings = Record<SpreadKind, SpreadAccount | null>;

type AccountRow = { id: string; code: string; name: string; account_class: string; account_type: string; system_key: string | null; currency_code: string | null; is_active: boolean };

export function parseKind(input: unknown): SpreadKind {
  return requireOneOf(input, "kind", SPREAD_KINDS);
}

export function parseMonth(input: unknown, fieldName = "month"): string {
  if (typeof input !== "string" || !ISO_MONTH.test(input) || Number(input.slice(5, 7)) < 1 || Number(input.slice(5, 7)) > 12) {
    throw new ValidationError(`${fieldName} is a month, like 2026-07.`);
  }
  return input;
}

export function parseDate(input: unknown, what: string): string {
  if (typeof input !== "string" || !ISO_DATE.test(input) || Number.isNaN(Date.parse(`${input}T00:00:00Z`))) throw new ValidationError(`Give ${what}.`);
  return input;
}

export async function getSpreadingSettings(tx: OrgTx): Promise<SpreadingSettings> {
  const result = await tx.query<{ kind: SpreadKind; id: string; code: string; name: string }>(
    `select v.kind, a.id::text, a.code, a.name
       from spreading_settings s
       cross join lateral (values ('prepayment', s.prepayment_account_id), ('income_in_advance', s.income_in_advance_account_id),
                                  ('accrued_expense', s.accrued_expense_account_id), ('accrued_income', s.accrued_income_account_id)) v(kind, account_id)
       join accounts a on a.id = v.account_id`,
  );
  const settings: SpreadingSettings = { prepayment: null, income_in_advance: null, accrued_expense: null, accrued_income: null };
  for (const row of result.rows) settings[row.kind] = { id: row.id, code: row.code, name: row.name };
  return settings;
}

async function accountByCode(tx: OrgTx, code: string): Promise<AccountRow | null> {
  const result = await tx.query<AccountRow>(
    "select id::text, code, name, account_class, account_type, system_key, currency_code, is_active from accounts where lower(code) = lower($1)",
    [code],
  );
  return result.rows[0] ?? null;
}

function holdingProblem(kind: SpreadKind, account: AccountRow): string | null {
  const wanted = HOLDING[kind].accountType;
  if (!account.is_active) return "it's archived.";
  if (account.system_key) return "Tohyee uses it for something else.";
  if (account.currency_code) return "it holds a foreign currency.";
  if (account.account_type !== wanted) return `it isn't a ${wanted === "current_asset" ? "current asset" : "current liability"} account.`;
  return null;
}

/**
 * Turns Spreading on, or changes its accounts (admins). A kind left out keeps
 * its account; a kind with none yet gets the account of that name if there is
 * one, or a new one. Two kinds can't share an account: each ties out alone.
 */
export async function saveSpreadingSettings(tx: OrgTx, bodyInput: unknown): Promise<SpreadingSettings> {
  const body = asRecord(bodyInput ?? {}, "body");
  const accounts = body.accounts === undefined ? {} : asRecord(body.accounts, "accounts");
  if (body.booksElsewhere !== undefined && typeof body.booksElsewhere !== "boolean") throw new ValidationError("booksElsewhere is true or false.");
  const booksElsewhere = body.booksElsewhere as boolean | undefined;
  const current = await getSpreadingSettings(tx);
  const chosen: Record<SpreadKind, string | null> = { prepayment: null, income_in_advance: null, accrued_expense: null, accrued_income: null };
  const added: string[] = [];
  for (const kind of SPREAD_KINDS) {
    const label = SPREAD_KIND_LABELS[kind];
    const asked = accounts[kind];
    if (asked !== undefined && asked !== null && asked !== "") {
      const account = await accountByCode(tx, requireString(asked, `${label} account`, { maxLength: 20 }));
      if (!account) throw new ValidationError(`There's no account ${String(asked)} for ${label}.`);
      const problem = holdingProblem(kind, account);
      if (problem) throw new ValidationError(`${account.code} ${account.name} can't hold ${label}: ${problem}`);
      // Once months have posted the account stays, or the worksheet would stop matching the ledger.
      if (current[kind] && current[kind]!.id !== account.id) {
        const posted = await tx.query("select 1 from spread_runs where kind = $1 and status = 'active' limit 1", [kind]);
        if (posted.rows[0]) throw new ConflictError(`${label} has months posted to ${current[kind]!.code}. Undo them before changing its account.`);
      }
      chosen[kind] = account.id;
      continue;
    }
    if (current[kind]) {
      chosen[kind] = current[kind]!.id;
      continue;
    }
    const byName = await tx.query<AccountRow>(
      `select id::text, code, name, account_class, account_type, system_key, currency_code, is_active from accounts
        where lower(name) = lower($1) and account_type = $2 and is_active and system_key is null and currency_code is null order by code limit 1`,
      [HOLDING[kind].name, HOLDING[kind].accountType],
    );
    if (byName.rows[0]) {
      chosen[kind] = byName.rows[0].id;
      continue;
    }
    let made: string | null = null;
    for (const code of HOLDING[kind].codes) {
      if (await accountByCode(tx, code)) continue;
      const account = await createAccount(tx, { code, name: HOLDING[kind].name, accountType: HOLDING[kind].accountType });
      made = account.id;
      added.push(`${account.code} ${account.name}`);
      break;
    }
    if (!made) throw new ValidationError(`Choose an account for ${label}: the usual codes are taken.`);
    chosen[kind] = made;
  }
  const ids = SPREAD_KINDS.map((kind) => chosen[kind]);
  if (new Set(ids).size !== ids.length) throw new ValidationError("Use a different account for each kind, so each can be checked against the ledger on its own.");
  await tx.query(
    `insert into spreading_settings (only_row, prepayment_account_id, income_in_advance_account_id, accrued_expense_account_id, accrued_income_account_id, updated_by_email, books_elsewhere)
     values (true, $1, $2, $3, $4, $5, coalesce($6, false))
     on conflict (only_row) do update set prepayment_account_id = excluded.prepayment_account_id, income_in_advance_account_id = excluded.income_in_advance_account_id,
       accrued_expense_account_id = excluded.accrued_expense_account_id, accrued_income_account_id = excluded.accrued_income_account_id,
       updated_by_email = excluded.updated_by_email, updated_at = now(), books_elsewhere = coalesce($6, spreading_settings.books_elsewhere)`,
    [chosen.prepayment, chosen.income_in_advance, chosen.accrued_expense, chosen.accrued_income, tx.actor.email, booksElsewhere ?? null],
  );
  await writeAuditEvent(tx, { eventType: "spreading.settings_saved", entityType: "spreading_settings", entityId: "1", details: { accounts: chosen, added, booksElsewhere: booksElsewhere ?? null } });
  return getSpreadingSettings(tx);
}

// Items --------------------------------------------------------------------------------------------------

export type SpreadItemMonth = { month: string; lineKind: "share" | "difference"; amount: string; runId: string | null };

export type SpreadItem = {
  id: string;
  kind: SpreadKind;
  description: string;
  contactId: string | null;
  contactName: string | null;
  target: SpreadAccount;
  amount: string;
  method: SpreadMethod;
  startDate: string | null;
  endDate: string | null;
  /** An accrual whose bill or invoice has arrived (SW6, SW7). */
  settledMonth: string | null;
  settledAmount: string | null;
  months: SpreadItemMonth[];
  /** What has posted, and what is still held for it in the kind's account. */
  posted: string;
  left: string;
  /** Nothing more will post for it. */
  finished: boolean;
  /** "Bill arrived" or "Invoice sent" can still be undone: its difference hasn't posted (SW21). */
  canUnsettle: boolean;
  /** "When it's done" that hasn't been marked done yet (SW12). */
  waiting: boolean;
  /** The bill or invoice line "Spread this" was pressed on (SW15, SW16), or null when it was added on the worksheet. */
  source: { kind: SourceKind; documentId: string; label: string } | null;
  tracking: TrackingTags;
  /** Custom fields for the income or expense line of each month's journal (SW25). */
  customFields: CustomValues;
  createdByEmail: string;
  createdAt: string;
};

type ItemRow = {
  bill_id: string | null;
  bill_number: string | null;
  bill_supplier: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  bank_id: string | null;
  bank_kind: string | null;
  bank_date: string | null;
  bank_contact: string | null;
  move_journal_id: string | null;
  tracking: TrackingTags | null;
  custom_fields: CustomValues | null;
  id: string;
  kind: SpreadKind;
  description: string;
  contact_id: string | null;
  contact_name: string | null;
  target_id: string;
  target_code: string;
  target_name: string;
  amount: string;
  method: SpreadMethod;
  start_date: string | null;
  end_date: string | null;
  settled_month: string | null;
  settled_amount: string | null;
  created_by_email: string;
  created_at: Date | string;
};

const ITEM_SELECT = `select i.id::text, i.kind, i.description, i.contact_id::text, c.name as contact_name, t.id::text as target_id, t.code as target_code, t.name as target_name,
    i.amount::text, i.method, to_char(i.start_date, 'YYYY-MM-DD') as start_date, to_char(i.end_date, 'YYYY-MM-DD') as end_date,
    to_char(i.settled_month, 'YYYY-MM') as settled_month, i.settled_amount::text, i.created_by_email, i.created_at,
    i.move_journal_id::text, i.tracking, i.custom_fields, b.id::text as bill_id, b.supplier_invoice_number as bill_number, bc.name as bill_supplier,
    si.id::text as invoice_id, si.invoice_number,
    k.id::text as bank_id, k.kind as bank_kind, to_char(k.transaction_date, 'YYYY-MM-DD') as bank_date, kc.name as bank_contact
  from spread_items i join accounts t on t.id = i.target_account_id left join contacts c on c.id = i.contact_id
  left join bill_lines bl on bl.id = i.bill_line_id left join bills b on b.id = bl.bill_id left join contacts bc on bc.id = b.contact_id
  left join sales_invoice_lines sl on sl.id = i.invoice_line_id left join sales_invoices si on si.id = sl.invoice_id
  left join bank_transaction_lines kl on kl.id = i.bank_line_id left join bank_transactions k on k.id = kl.bank_transaction_id left join contacts kc on kc.id = k.contact_id`;

/**
 * What an item still holds in its kind's account (SW11).
 * - Paid in advance and income in advance: the amount, less what has posted.
 * - The two accruals: what has been accrued (and any difference posted),
 *   less the bill or invoice once it's marked as arrived.
 */
function itemLeft(kind: SpreadKind, amount: string, months: SpreadItemMonth[], settledAmount: string | null): { posted: string; left: string } {
  const postedRows = months.filter((row) => row.runId !== null);
  const posted = sum(postedRows.map((row) => dec(row.amount)));
  if (kind === "prepayment" || kind === "income_in_advance") {
    return { posted: toFixedString(posted, 2), left: toFixedString(sub(dec(amount), posted), 2) };
  }
  return { posted: toFixedString(posted, 2), left: toFixedString(settledAmount ? sub(posted, dec(settledAmount)) : posted, 2) };
}

function toItem(row: ItemRow, months: SpreadItemMonth[]): SpreadItem {
  const { posted, left } = itemLeft(row.kind, row.amount, months, row.settled_amount);
  const unposted = months.some((entry) => entry.runId === null);
  const waiting = row.method === "when_done" && months.length === 0;
  return {
    id: row.id,
    kind: row.kind,
    description: row.description,
    contactId: row.contact_id,
    contactName: row.contact_name,
    target: { id: row.target_id, code: row.target_code, name: row.target_name },
    amount: toFixedString(dec(row.amount), 2),
    method: row.method,
    startDate: row.start_date,
    endDate: row.end_date,
    settledMonth: row.settled_month,
    settledAmount: row.settled_amount ? toFixedString(dec(row.settled_amount), 2) : null,
    months,
    posted,
    left,
    finished: !unposted && !waiting && (row.kind === "prepayment" || row.kind === "income_in_advance" || row.settled_month !== null),
    waiting,
    canUnsettle: row.settled_month !== null && !months.some((entry) => entry.runId !== null && entry.month >= row.settled_month!),
    source: row.bill_id
      ? { kind: "bill", documentId: row.bill_id, label: sourceLabel("bill", { documentId: row.bill_id, number: row.bill_number, contactName: row.bill_supplier, docKind: null, date: null }) }
      : row.invoice_id
        ? { kind: "invoice", documentId: row.invoice_id, label: sourceLabel("invoice", { documentId: row.invoice_id, number: row.invoice_number, contactName: null, docKind: null, date: null }) }
        : row.bank_id
          ? { kind: "bank", documentId: row.bank_id, label: sourceLabel("bank", { documentId: row.bank_id, number: null, contactName: row.bank_contact, docKind: row.bank_kind, date: row.bank_date }) }
          : null,
    tracking: row.tracking ?? {},
    customFields: row.custom_fields ?? {},
    createdByEmail: row.created_by_email,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function monthsOf(tx: OrgTx, itemIds: string[]): Promise<Map<string, SpreadItemMonth[]>> {
  const byItem = new Map<string, SpreadItemMonth[]>();
  if (itemIds.length === 0) return byItem;
  const result = await tx.query<{ item_id: string; month: string; line_kind: "share" | "difference"; amount: string; run_id: string | null }>(
    `select item_id::text, to_char(month, 'YYYY-MM') as month, line_kind, amount::text, run_id::text
       from spread_item_months where item_id = any($1::bigint[]) order by month, line_kind desc`,
    [itemIds],
  );
  for (const row of result.rows) {
    const list = byItem.get(row.item_id) ?? [];
    list.push({ month: row.month, lineKind: row.line_kind, amount: toFixedString(dec(row.amount), 2), runId: row.run_id });
    byItem.set(row.item_id, list);
  }
  return byItem;
}

export async function listSpreadItems(tx: OrgTx, filter: { kind?: SpreadKind } = {}): Promise<SpreadItem[]> {
  const result = await tx.query<ItemRow>(`${ITEM_SELECT} where i.removed_at is null and ($1::text is null or i.kind = $1) order by i.id`, [filter.kind ?? null]);
  const months = await monthsOf(tx, result.rows.map((row) => row.id));
  return result.rows.map((row) => toItem(row, months.get(row.id) ?? []));
}

export async function getSpreadItem(tx: OrgTx, idInput: unknown): Promise<SpreadItem> {
  const id = requireId(idInput, "itemId");
  const result = await tx.query<ItemRow>(`${ITEM_SELECT} where i.id = $1 and i.removed_at is null`, [id]);
  if (!result.rows[0]) throw new NotFoundError("That item isn't on the worksheet.");
  const months = await monthsOf(tx, [id]);
  return toItem(result.rows[0], months.get(id) ?? []);
}

/** One writer at a time on the worksheet, so two people can't post or change the same month at once. */
export async function lockWorksheet(tx: OrgTx): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtext('tohyee.spreading'))");
}

/** The latest month posted for a kind, or null. */
export async function latestPostedMonth(tx: OrgTx, kind: SpreadKind): Promise<string | null> {
  const result = await tx.query<{ month: string | null }>("select to_char(max(month), 'YYYY-MM') as month from spread_runs where kind = $1 and status = 'active'", [kind]);
  return result.rows[0]?.month ?? null;
}

export async function writeMonths(tx: OrgTx, itemId: string, rows: SpreadMonth[], lineKind: "share" | "difference" = "share"): Promise<void> {
  for (const row of rows) {
    await tx.query("insert into spread_item_months (item_id, month, line_kind, amount) values ($1, $2, $3, $4::numeric)", [itemId, `${row.month}-01`, lineKind, row.amount]);
  }
}

/**
 * The tracking and line custom fields typed for an item (SW25), checked as a
 * journal line's are: real values, not archived, fields that are used on
 * journal lines. `kept` lets an item keep what it already has.
 */
async function resolveTags(
  tx: OrgTx,
  body: Record<string, unknown>,
  fallback: { tracking: TrackingTags; customFields: CustomValues },
): Promise<{ tracking: TrackingTags; customFields: CustomValues }> {
  let tracking = fallback.tracking;
  if (body.tracking !== undefined) {
    tracking = sortedTags(parseTrackingInput(body.tracking, "This item"));
    checkNewTags(await loadTrackingContext(tx), tracking, "This item", new Set(Object.values(fallback.tracking)));
  }
  let customFields = fallback.customFields;
  if (body.customFields !== undefined) {
    const raw = parseCustomInput(body.customFields, "");
    customFields = resolveCustomValues(await loadCustomFieldContext(tx), raw ?? {}, { record: "line", uses: ["journal"] });
  }
  return { tracking, customFields };
}

/** The bill, invoice or bank line named in a request, if any. */
function parseSourceRef(body: Record<string, unknown>): { sourceKind: SourceKind; lineId: string } | null {
  const refs = (
    [
      ["bill", optionalId(body.billLineId, "billLineId")],
      ["invoice", optionalId(body.invoiceLineId, "invoiceLineId")],
      ["bank", optionalId(body.bankLineId, "bankLineId")],
    ] as const
  ).filter(([, id]) => id !== null);
  if (refs.length > 1) throw new ValidationError("Give one line: a bill's, an invoice's or a bank transaction's.");
  return refs[0] ? { sourceKind: refs[0][0], lineId: refs[0][1]! } : null;
}

export type CaughtUp = { months: number; amount: string; into: string };

/**
 * Adds an item to the worksheet (bookkeepers; SW1-SW7, SW12, SW13, SW15,
 * SW16, SW19). Months that have already posted for its kind are caught up
 * in the next month to post (SW18).
 */
export async function createSpreadItem(tx: OrgTx, bodyInput: unknown): Promise<{ created: boolean; item: SpreadItem; caughtUp: CaughtUp | null }> {
  const body = asRecord(bodyInput, "body");
  const source = optionalSource(body.source);
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  // "Spread this" on a bill, invoice or bank line (SW15, SW16, SW19): the line says the kind, the amount and the account.
  const fromLine = parseSourceRef(body);
  // A bank line's kind depends on whether money was spent or received, which the line knows; a typed one says its kind.
  const typedKind = fromLine ? null : parseKind(body.kind);
  const blankDescription = body.description == null || (typeof body.description === "string" && body.description.trim() === "");
  const typedDescription = fromLine && blankDescription ? null : requireString(body.description, "What it is", { maxLength: 200 });
  const method = requireOneOf(body.method ?? "by_month", "method", SPREAD_METHODS);
  const typedContactId = fromLine ? null : optionalId(body.contactId, "contactId");
  const dated = method === "by_month" || method === "by_days";
  const startDate = dated ? parseDate(body.startDate, "the first day it covers") : null;
  const endDate = dated ? parseDate(body.endDate, "the last day it covers") : null;
  const month = method === "one_month" ? parseMonth(body.month, "The month it lands in") : null;
  const ownAmounts =
    method === "own_amounts"
      ? requireArray(body.ownAmounts, "ownAmounts", 120).map((entry) => {
          const row = asRecord(entry, "ownAmounts");
          return { month: parseMonth(row.month), amount: requireString(row.amount, "amount", { maxLength: 20 }) };
        })
      : null;
  const typedAmount = fromLine ? null : requireString(body.amount, "The amount", { maxLength: 20 }).replaceAll(",", "");
  const typedTarget = fromLine ? null : requireString(body.targetAccountCode, typedKind === "prepayment" || typedKind === "accrued_expense" ? "The expense account" : "The income account", { maxLength: 20 });
  const hash = requestHash("spread_item", {
    kind: typedKind, description: typedDescription, method, contactId: typedContactId, startDate, endDate, month, ownAmounts, amount: typedAmount, targetAccountCode: typedTarget, from: fromLine,
    // Left out of the hash when not given, so requests made before tags existed still replay.
    ...(body.tracking !== undefined ? { tracking: body.tracking } : {}),
    ...(body.customFields !== undefined ? { customFields: body.customFields } : {}),
  });

  const earlier = await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from spread_items where command_source = $1 and idempotency_key = $2", [source, idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "item");
    return { created: false, item: await getSpreadItem(tx, earlier.rows[0].id), caughtUp: null };
  }
  await lockWorksheet(tx);

  const settings = await getSpreadingSettings(tx);
  const line = fromLine ? await loadSourceLine(tx, fromLine.sourceKind, fromLine.lineId) : null;
  const kind = line ? line.kind : typedKind!;
  const holding = settings[kind];
  if (!holding) throw new ValidationError("Turn Spreading on first: it needs an account to hold this in.");
  const amount = line ? line.amount : typedAmount!;
  const description = typedDescription ?? line!.description.trim().slice(0, 200);
  const contactId = line ? line.contactId : typedContactId;
  const planned = spreadSchedule({ amount, method, startDate, endDate, month, ownAmounts });
  const target = await accountByCode(tx, line ? line.accountCode : typedTarget!);
  if (!target) throw new ValidationError(`There's no account ${String(body.targetAccountCode)}.`);
  if (!target.is_active) throw new ValidationError(`${target.code} ${target.name} is archived.`);
  if (target.account_class !== TARGET_CLASS[kind]) {
    throw new ValidationError(`${target.code} ${target.name} isn't ${TARGET_CLASS[kind] === "expense" ? "an expense" : "an income"} account, and ${SPREAD_KIND_LABELS[kind].toLowerCase()} lands on one.`);
  }
  if (target.currency_code) throw new ValidationError(`${target.code} ${target.name} holds a foreign currency, which Spreading doesn't do yet.`);
  if (contactId && !line) {
    const contact = await tx.query("select 1 from contacts where id = $1", [contactId]);
    if (!contact.rows[0]) throw new ValidationError("That contact isn't in this organisation.");
  }
  // "Spread this" starts from the line's own tracking; either way the person can say otherwise (SW25).
  const tags = await resolveTags(tx, body, { tracking: line?.tracking ?? {}, customFields: {} });
  // Months that have already posted aren't reopened: their amounts go in the next month to post (SW18).
  const { schedule, caughtUp } = catchUp(planned, await latestPostedMonth(tx, kind));

  const inserted = await tx.query<{ id: string }>(
    `insert into spread_items (command_source, idempotency_key, request_hash, kind, description, contact_id, target_account_id, amount, method, start_date, end_date,
                               created_by_user_id, created_by_email, bill_line_id, invoice_line_id, bank_line_id, tracking, custom_fields)
     values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb) returning id::text`,
    [
      source, idempotencyKey, hash, kind, description, contactId, target.id, amount, method, startDate, endDate, tx.actor.userId, tx.actor.email,
      line?.sourceKind === "bill" ? line.lineId : null,
      line?.sourceKind === "invoice" ? line.lineId : null,
      line?.sourceKind === "bank" ? line.lineId : null,
      JSON.stringify(tags.tracking),
      JSON.stringify(tags.customFields),
    ],
  );
  const id = inserted.rows[0].id;
  await writeMonths(tx, id, schedule);
  let moveJournalId: string | null = null;
  if (line) {
    moveJournalId = await postMove(tx, id, line, holding.code, description);
    await tx.query("update spread_items set move_journal_id = $2 where id = $1", [id, moveJournalId]);
  }
  await writeAuditEvent(tx, {
    eventType: "spread_item.created",
    entityType: "spread_item",
    entityId: id,
    details: { kind, description, amount, method, months: schedule.length, caughtUp, from: line ? { kind: line.sourceKind, lineId: line.lineId, label: line.label, moveJournalId } : null },
  });
  return { created: true, item: await getSpreadItem(tx, id), caughtUp };
}

export function postedThrough(item: SpreadItem): string | null {
  const posted = item.months.filter((row) => row.runId !== null && row.lineKind === "share").map((row) => row.month);
  return posted.length ? posted[posted.length - 1] : null;
}

/** The months still to come can't be put into a month the kind has already posted. */
async function assertMonthOpen(tx: OrgTx, kind: SpreadKind, month: string): Promise<void> {
  const latest = await latestPostedMonth(tx, kind);
  if (latest && month <= latest) throw new ConflictError(`${SPREAD_KIND_LABELS[kind]} is already posted to ${latest}. Choose a later month, or undo back to ${month} first.`);
}

/** Changes an item's tracking and custom fields (SW25), for the months not yet posted. */
export async function updateSpreadItemTags(tx: OrgTx, idInput: unknown, bodyInput: unknown): Promise<SpreadItem> {
  const body = asRecord(bodyInput, "body");
  await lockWorksheet(tx);
  const item = await getSpreadItem(tx, idInput);
  const tags = await resolveTags(tx, body, { tracking: item.tracking, customFields: item.customFields });
  await tx.query("update spread_items set tracking = $2::jsonb, custom_fields = $3::jsonb, updated_at = now() where id = $1", [item.id, JSON.stringify(tags.tracking), JSON.stringify(tags.customFields)]);
  await writeAuditEvent(tx, { eventType: "spread_item.tags_changed", entityType: "spread_item", entityId: item.id, details: { from: { tracking: item.tracking, customFields: item.customFields }, to: tags } });
  return getSpreadItem(tx, item.id);
}

/** Ends an item early (SW8): what's left moves into one month. Posted months don't change. */
export async function endSpreadItemEarly(tx: OrgTx, idInput: unknown, bodyInput: unknown): Promise<SpreadItem> {
  const month = parseMonth(asRecord(bodyInput, "body").month, "The month to release the rest in");
  await lockWorksheet(tx);
  const item = await getSpreadItem(tx, idInput);
  if (item.kind === "accrued_expense" || item.kind === "accrued_income") throw new ValidationError("An accrual ends when its bill or invoice arrives: mark that instead.");
  if (item.waiting) throw new ValidationError("It hasn't been marked done yet: mark it done in the month you want.");
  if (!item.months.some((row) => row.runId === null)) throw new ConflictError("Every month has posted, so there's nothing left to end early.");
  await assertMonthOpen(tx, item.kind, month);
  const shares = item.months.filter((row) => row.lineKind === "share").map((row) => ({ month: row.month, amount: row.amount }));
  const through = postedThrough(item);
  const next = endEarly(shares, through, month).filter((row) => through === null || row.month > through);
  await tx.query("delete from spread_item_months where item_id = $1 and run_id is null", [item.id]);
  await writeMonths(tx, item.id, next);
  await tx.query("update spread_items set updated_at = now() where id = $1", [item.id]);
  await writeAuditEvent(tx, { eventType: "spread_item.ended_early", entityType: "spread_item", entityId: item.id, details: { month, amount: next[0]?.amount ?? "0.00" } });
  return getSpreadItem(tx, item.id);
}

/** Marks a "when it's done" item finished (SW12): all of it lands in that month. */
export async function markSpreadItemDone(tx: OrgTx, idInput: unknown, bodyInput: unknown): Promise<SpreadItem> {
  const month = parseMonth(asRecord(bodyInput, "body").month, "The month it was done");
  await lockWorksheet(tx);
  const item = await getSpreadItem(tx, idInput);
  if (item.method !== "when_done") throw new ValidationError("Only an item set to \"When it's done\" is marked done.");
  if (item.months.some((row) => row.runId !== null)) throw new ConflictError("It has already posted.");
  await assertMonthOpen(tx, item.kind, month);
  await tx.query("delete from spread_item_months where item_id = $1 and run_id is null", [item.id]);
  await writeMonths(tx, item.id, spreadSchedule({ amount: item.amount, method: "when_done", month }));
  await tx.query("update spread_items set updated_at = now() where id = $1", [item.id]);
  await writeAuditEvent(tx, { eventType: "spread_item.marked_done", entityType: "spread_item", entityId: item.id, details: { month } });
  return getSpreadItem(tx, item.id);
}

/**
 * An accrual's bill or invoice has arrived (SW6, SW7, SW20): the months not
 * yet posted are dropped, and what it came to over or under what was accrued
 * goes in that month's journal. Either the person coded the bill or invoice
 * to the kind's account and gives the amount, or they name the line (coded
 * to its expense or income account as usual) and its amount is moved there.
 */
export async function settleSpreadItem(tx: OrgTx, idInput: unknown, bodyInput: unknown): Promise<SpreadItem> {
  const body = asRecord(bodyInput, "body");
  const fromLine = parseSourceRef(body);
  const typedMonth = body.month == null || body.month === "" ? null : parseMonth(body.month, "The month it arrived");
  if (!fromLine && !typedMonth) throw new ValidationError("Give the month it arrived.");
  const typedAmount = fromLine ? null : requireString(body.amount, "What it came to", { maxLength: 20 }).replaceAll(",", "");
  await lockWorksheet(tx);
  const item = await getSpreadItem(tx, idInput);
  if (item.kind !== "accrued_expense" && item.kind !== "accrued_income") throw new ValidationError("Only an accrual waits for a bill or invoice.");
  if (item.settledMonth) throw new ConflictError(`It was already marked as arrived in ${item.settledMonth}.`);
  let line: SourceLine | null = null;
  if (fromLine) {
    line = await loadSourceLine(tx, fromLine.sourceKind, fromLine.lineId);
    if (line.accrualKind !== item.kind) {
      throw new ValidationError(item.kind === "accrued_expense" ? "A cost not billed yet is settled by a bill or money spent, not by income." : "Income not invoiced yet is settled by an invoice or money received, not by a cost.");
    }
  }
  const latest = await latestPostedMonth(tx, item.kind);
  // The bill's or invoice's own month, or the next month to post if that one has gone (SW20).
  const lineMonth = line ? line.date.slice(0, 7) : null;
  const month = typedMonth ?? (latest && lineMonth! <= latest ? addMonths(latest, 1) : lineMonth!);
  await assertMonthOpen(tx, item.kind, month);
  const billed = spreadSchedule({ amount: line ? line.amount : typedAmount!, method: "one_month", month })[0].amount;
  const accrued = sum(item.months.filter((row) => row.runId !== null).map((row) => dec(row.amount)));
  const difference = sub(dec(billed), accrued);
  const dropped = item.months.filter((row) => row.runId === null).map((row) => ({ month: row.month, amount: row.amount }));
  await tx.query("delete from spread_item_months where item_id = $1 and run_id is null", [item.id]);
  if (!isZero(difference)) await writeMonths(tx, item.id, [{ month, amount: toFixedString(difference, 2) }], "difference");
  let moveJournalId: string | null = null;
  if (line) {
    const holding = (await getSpreadingSettings(tx))[item.kind]!;
    moveJournalId = await postMove(tx, item.id, line, holding.code, item.description);
  }
  await tx.query(
    `update spread_items set settled_month = $2, settled_amount = $3::numeric, settled_dropped = $4::jsonb, move_journal_id = $5, move_undo_journal_id = null,
            bill_line_id = $6, invoice_line_id = $7, bank_line_id = $8, updated_at = now() where id = $1`,
    [
      item.id, `${month}-01`, billed, JSON.stringify(dropped), moveJournalId,
      line?.sourceKind === "bill" ? line.lineId : null,
      line?.sourceKind === "invoice" ? line.lineId : null,
      line?.sourceKind === "bank" ? line.lineId : null,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "spread_item.settled",
    entityType: "spread_item",
    entityId: item.id,
    details: { month, billed, accrued: toFixedString(accrued, 2), difference: toFixedString(difference, 2), from: line ? { kind: line.sourceKind, lineId: line.lineId, label: line.label, moveJournalId } : null },
  });
  return getSpreadItem(tx, item.id);
}

/**
 * Undoes "bill arrived" or "invoice sent" (SW21), until its difference has
 * posted: the dropped months come back (caught up if they've been passed),
 * and a move from a bill, invoice or bank line is reversed on its date.
 */
export async function unsettleSpreadItem(tx: OrgTx, idInput: unknown): Promise<SpreadItem> {
  await lockWorksheet(tx);
  const item = await getSpreadItem(tx, idInput);
  if (!item.settledMonth) throw new ConflictError("It hasn't been marked as arrived.");
  if (!item.canUnsettle) throw new ConflictError(`${item.settledMonth} has posted with its difference. Undo that month first.`);
  const stored = await tx.query<{ settled_dropped: SpreadMonth[] | null; move_journal_id: string | null }>("select settled_dropped, move_journal_id::text from spread_items where id = $1", [item.id]);
  const moveJournalId = stored.rows[0].move_journal_id;
  const undoJournalId = moveJournalId ? await reverseMove(tx, moveJournalId) : null;
  await tx.query("delete from spread_item_months where item_id = $1 and run_id is null", [item.id]);
  const back = catchUp(stored.rows[0].settled_dropped ?? [], await latestPostedMonth(tx, item.kind)).schedule;
  await writeMonths(tx, item.id, back);
  await tx.query(
    `update spread_items set settled_month = null, settled_amount = null, settled_dropped = null, move_journal_id = null, move_undo_journal_id = $2,
            bill_line_id = null, invoice_line_id = null, bank_line_id = null, updated_at = now() where id = $1`,
    [item.id, undoJournalId],
  );
  await writeAuditEvent(tx, { eventType: "spread_item.unsettled", entityType: "spread_item", entityId: item.id, details: { wasMonth: item.settledMonth, wasAmount: item.settledAmount, moveJournalId, undoJournalId } });
  return getSpreadItem(tx, item.id);
}

/** Unsettled accruals of a kind, for "It's the bill for" on a bill, invoice or bank transaction (SW20). */
export async function listOpenAccruals(tx: OrgTx, kind: SpreadKind): Promise<Array<{ id: string; description: string; accrued: string; targetCode: string; targetName: string }>> {
  const items = await listSpreadItems(tx, { kind });
  return items
    .filter((item) => !item.settledMonth)
    .map((item) => ({ id: item.id, description: item.description, accrued: item.posted, targetCode: item.target.code, targetName: item.target.name }));
}

/** Takes an item off the worksheet. Only before anything has posted for it: after that, end it early. One from a bill or invoice line has its move reversed. */
export async function removeSpreadItem(tx: OrgTx, idInput: unknown): Promise<void> {
  await lockWorksheet(tx);
  const item = await getSpreadItem(tx, idInput);
  if (item.months.some((row) => row.runId !== null)) throw new ConflictError("Some of its months have posted, so it can't be removed. End it early, or undo those months first.");
  // From a bill or invoice line (SW17): the amount goes back on the line's account.
  const moved = await tx.query<{ move_journal_id: string | null }>("select move_journal_id::text from spread_items where id = $1", [item.id]);
  const moveJournalId = moved.rows[0]?.move_journal_id ?? null;
  const undoJournalId = moveJournalId ? await reverseMove(tx, moveJournalId) : null;
  await tx.query("delete from spread_item_months where item_id = $1", [item.id]);
  await tx.query("update spread_items set removed_at = now(), removed_by_email = $2, move_undo_journal_id = $3 where id = $1", [item.id, tx.actor.email, undoJournalId]);
  await writeAuditEvent(tx, { eventType: "spread_item.removed", entityType: "spread_item", entityId: item.id, details: { description: item.description, amount: item.amount } });
}

// The worksheet --------------------------------------------------------------------------------------------

export type SpreadTieOut = {
  kind: SpreadKind;
  account: SpreadAccount | null;
  /** What the worksheet says is held. */
  worksheet: string;
  /** What the account holds in the ledger, the way that kind runs (an asset's debits, a liability's credits). */
  ledger: string;
  /** Ledger less worksheet: zero is "Matches" (SW11). */
  difference: string;
};

/** Shop orders paid and not sent yet, held by Sales when sent (SW22). */
export type ShopHeld = { account: SpreadAccount; held: string; /** In the same account as income in advance, so the check counts it. */ counted: boolean };

export type SpreadWorksheet = {
  ready: boolean;
  settings: SpreadingSettings;
  items: SpreadItem[];
  tieOut: SpreadTieOut[];
  shopHeld: ShopHeld[];
  /** The books are kept in other software (SW23): no check against this ledger. */
  booksElsewhere: boolean;
  /** The latest month posted for each kind, and its run (for undo). */
  posted: Record<SpreadKind, { month: string; runId: string; journalId: string | null; total: string } | null>;
};

export async function getSpreadWorksheet(tx: OrgTx): Promise<SpreadWorksheet> {
  const settings = await getSpreadingSettings(tx);
  const items = await listSpreadItems(tx);
  const tieOut: SpreadTieOut[] = [];
  const options = await tx.query<{ books_elsewhere: boolean }>("select books_elsewhere from spreading_settings");
  const heldRows = await tx.query<{ id: string; code: string; name: string; held: string }>(
    `select a.id::text, a.code, a.name, sum(h.amount - h.recognised_amount - h.refunded_amount)::text as held
       from sales_platform_held_lines h join accounts a on a.id = h.held_account_id
      where not h.closed group by a.id, a.code, a.name having sum(h.amount - h.recognised_amount - h.refunded_amount) <> 0 order by a.code`,
  );
  const shopHeld: ShopHeld[] = heldRows.rows.map((row) => ({
    account: { id: row.id, code: row.code, name: row.name },
    held: toFixedString(dec(row.held), 2),
    counted: row.id === settings.income_in_advance?.id,
  }));
  const posted = { prepayment: null, income_in_advance: null, accrued_expense: null, accrued_income: null } as SpreadWorksheet["posted"];
  for (const kind of SPREAD_KINDS) {
    const account = settings[kind];
    const worksheet = sum([
      ...items.filter((item) => item.kind === kind).map((item) => dec(item.left)),
      ...(kind === "income_in_advance" ? shopHeld.filter((row) => row.counted).map((row) => dec(row.held)) : []),
    ]);
    let ledger = ZERO_DECIMAL;
    if (account) {
      const balance = await tx.query<{ net: string }>("select coalesce(sum(debit_amount - credit_amount), 0)::text as net from ledger_journal_lines where account_id = $1", [account.id]);
      const net = dec(balance.rows[0].net);
      ledger = HOLDING[kind].accountType === "current_asset" ? net : neg(net);
    }
    tieOut.push({ kind, account, worksheet: toFixedString(worksheet, 2), ledger: toFixedString(ledger, 2), difference: toFixedString(sub(ledger, worksheet), 2) });
    const run = await tx.query<{ id: string; month: string; journal_id: string | null; total: string }>(
      "select id::text, to_char(month, 'YYYY-MM') as month, journal_id::text, total::text from spread_runs where kind = $1 and status = 'active' order by month desc limit 1",
      [kind],
    );
    if (run.rows[0]) posted[kind] = { month: run.rows[0].month, runId: run.rows[0].id, journalId: run.rows[0].journal_id, total: toFixedString(dec(run.rows[0].total), 2) };
  }
  return { ready: SPREAD_KINDS.every((kind) => settings[kind] !== null), settings, items, tieOut, shopHeld, booksElsewhere: options.rows[0]?.books_elsewhere ?? false, posted };
}
