import { createAccount } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { dec, isZero, neg, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  endEarly,
  SPREAD_KIND_LABELS,
  SPREAD_KINDS,
  SPREAD_METHODS,
  type SpreadKind,
  type SpreadMethod,
  type SpreadMonth,
  spreadSchedule,
} from "@/lib/spreading/rules";
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

function parseDate(input: unknown, what: string): string {
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
    `insert into spreading_settings (only_row, prepayment_account_id, income_in_advance_account_id, accrued_expense_account_id, accrued_income_account_id, updated_by_email)
     values (true, $1, $2, $3, $4, $5)
     on conflict (only_row) do update set prepayment_account_id = excluded.prepayment_account_id, income_in_advance_account_id = excluded.income_in_advance_account_id,
       accrued_expense_account_id = excluded.accrued_expense_account_id, accrued_income_account_id = excluded.accrued_income_account_id,
       updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [chosen.prepayment, chosen.income_in_advance, chosen.accrued_expense, chosen.accrued_income, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "spreading.settings_saved", entityType: "spreading_settings", entityId: "1", details: { accounts: chosen, added } });
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
  /** "When it's done" that hasn't been marked done yet (SW12). */
  waiting: boolean;
  createdByEmail: string;
  createdAt: string;
};

type ItemRow = {
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
    to_char(i.settled_month, 'YYYY-MM') as settled_month, i.settled_amount::text, i.created_by_email, i.created_at
  from spread_items i join accounts t on t.id = i.target_account_id left join contacts c on c.id = i.contact_id`;

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

async function writeMonths(tx: OrgTx, itemId: string, rows: SpreadMonth[], lineKind: "share" | "difference" = "share"): Promise<void> {
  for (const row of rows) {
    await tx.query("insert into spread_item_months (item_id, month, line_kind, amount) values ($1, $2, $3, $4::numeric)", [itemId, `${row.month}-01`, lineKind, row.amount]);
  }
}

/**
 * Adds an item to the worksheet (bookkeepers; SW1-SW7, SW12, SW13). Its
 * months can't start in a month that has already posted for its kind: undo
 * that month first, or start the item later.
 */
export async function createSpreadItem(tx: OrgTx, bodyInput: unknown): Promise<{ created: boolean; item: SpreadItem }> {
  const body = asRecord(bodyInput, "body");
  const source = optionalSource(body.source);
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const kind = parseKind(body.kind);
  const description = requireString(body.description, "What it is", { maxLength: 200 });
  const method = requireOneOf(body.method ?? "by_month", "method", SPREAD_METHODS);
  const contactId = optionalId(body.contactId, "contactId");
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
  const amount = requireString(body.amount, "The amount", { maxLength: 20 }).replaceAll(",", "");
  const schedule = spreadSchedule({ amount, method, startDate, endDate, month, ownAmounts });
  const hash = requestHash("spread_item", { kind, description, method, contactId, startDate, endDate, month, ownAmounts, amount, targetAccountCode: body.targetAccountCode ?? null });

  const earlier = await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from spread_items where command_source = $1 and idempotency_key = $2", [source, idempotencyKey]);
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "item");
    return { created: false, item: await getSpreadItem(tx, earlier.rows[0].id) };
  }
  await lockWorksheet(tx);

  const settings = await getSpreadingSettings(tx);
  if (!settings[kind]) throw new ValidationError("Turn Spreading on first: it needs an account to hold this in.");
  const target = await accountByCode(tx, requireString(body.targetAccountCode, kind === "prepayment" || kind === "accrued_expense" ? "The expense account" : "The income account", { maxLength: 20 }));
  if (!target) throw new ValidationError(`There's no account ${String(body.targetAccountCode)}.`);
  if (!target.is_active) throw new ValidationError(`${target.code} ${target.name} is archived.`);
  if (target.account_class !== TARGET_CLASS[kind]) {
    throw new ValidationError(`${target.code} ${target.name} isn't ${TARGET_CLASS[kind] === "expense" ? "an expense" : "an income"} account, and ${SPREAD_KIND_LABELS[kind].toLowerCase()} lands on one.`);
  }
  if (target.currency_code) throw new ValidationError(`${target.code} ${target.name} holds a foreign currency, which Spreading doesn't do yet.`);
  if (contactId) {
    const contact = await tx.query("select 1 from contacts where id = $1", [contactId]);
    if (!contact.rows[0]) throw new ValidationError("That contact isn't in this organisation.");
  }
  const latest = await latestPostedMonth(tx, kind);
  if (latest && schedule.some((row) => row.month <= latest)) {
    throw new ConflictError(
      `${SPREAD_KIND_LABELS[kind]} is posted to ${latest}, and this would start in ${schedule[0].month}. Undo the months back to then, or use your own amounts from ${latest === schedule[0].month ? "the next month" : "a later month"}.`,
    );
  }

  const inserted = await tx.query<{ id: string }>(
    `insert into spread_items (command_source, idempotency_key, request_hash, kind, description, contact_id, target_account_id, amount, method, start_date, end_date,
                               created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13) returning id::text`,
    [source, idempotencyKey, hash, kind, description, contactId, target.id, amount, method, startDate, endDate, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeMonths(tx, id, schedule);
  await writeAuditEvent(tx, { eventType: "spread_item.created", entityType: "spread_item", entityId: id, details: { kind, description, amount, method, months: schedule.length } });
  return { created: true, item: await getSpreadItem(tx, id) };
}

function postedThrough(item: SpreadItem): string | null {
  const posted = item.months.filter((row) => row.runId !== null && row.lineKind === "share").map((row) => row.month);
  return posted.length ? posted[posted.length - 1] : null;
}

/** The months still to come can't be put into a month the kind has already posted. */
async function assertMonthOpen(tx: OrgTx, kind: SpreadKind, month: string): Promise<void> {
  const latest = await latestPostedMonth(tx, kind);
  if (latest && month <= latest) throw new ConflictError(`${SPREAD_KIND_LABELS[kind]} is already posted to ${latest}. Choose a later month, or undo back to ${month} first.`);
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
 * An accrual's bill or invoice has arrived (SW6, SW7): the months not yet
 * posted are dropped, and what it came to over or under what was accrued
 * goes in that month's journal. The bill or invoice itself is coded to the
 * kind's account by the person.
 */
export async function settleSpreadItem(tx: OrgTx, idInput: unknown, bodyInput: unknown): Promise<SpreadItem> {
  const body = asRecord(bodyInput, "body");
  const month = parseMonth(body.month, "The month it arrived");
  const billed = spreadSchedule({ amount: requireString(body.amount, "What it came to", { maxLength: 20 }).replaceAll(",", ""), method: "one_month", month })[0].amount;
  await lockWorksheet(tx);
  const item = await getSpreadItem(tx, idInput);
  if (item.kind !== "accrued_expense" && item.kind !== "accrued_income") throw new ValidationError("Only an accrual waits for a bill or invoice.");
  if (item.settledMonth) throw new ConflictError(`It was already marked as arrived in ${item.settledMonth}.`);
  await assertMonthOpen(tx, item.kind, month);
  const accrued = sum(item.months.filter((row) => row.runId !== null).map((row) => dec(row.amount)));
  const difference = sub(dec(billed), accrued);
  await tx.query("delete from spread_item_months where item_id = $1 and run_id is null", [item.id]);
  if (!isZero(difference)) await writeMonths(tx, item.id, [{ month, amount: toFixedString(difference, 2) }], "difference");
  await tx.query("update spread_items set settled_month = $2, settled_amount = $3::numeric, updated_at = now() where id = $1", [item.id, `${month}-01`, billed]);
  await writeAuditEvent(tx, { eventType: "spread_item.settled", entityType: "spread_item", entityId: item.id, details: { month, billed, accrued: toFixedString(accrued, 2), difference: toFixedString(difference, 2) } });
  return getSpreadItem(tx, item.id);
}

/** Takes an item off the worksheet. Only before anything has posted for it: after that, end it early. */
export async function removeSpreadItem(tx: OrgTx, idInput: unknown): Promise<void> {
  await lockWorksheet(tx);
  const item = await getSpreadItem(tx, idInput);
  if (item.months.some((row) => row.runId !== null)) throw new ConflictError("Some of its months have posted, so it can't be removed. End it early, or undo those months first.");
  await tx.query("delete from spread_item_months where item_id = $1", [item.id]);
  await tx.query("update spread_items set removed_at = now(), removed_by_email = $2 where id = $1", [item.id, tx.actor.email]);
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

export type SpreadWorksheet = {
  ready: boolean;
  settings: SpreadingSettings;
  items: SpreadItem[];
  tieOut: SpreadTieOut[];
  /** The latest month posted for each kind, and its run (for undo). */
  posted: Record<SpreadKind, { month: string; runId: string; journalId: string | null; total: string } | null>;
};

export async function getSpreadWorksheet(tx: OrgTx): Promise<SpreadWorksheet> {
  const settings = await getSpreadingSettings(tx);
  const items = await listSpreadItems(tx);
  const tieOut: SpreadTieOut[] = [];
  const posted = { prepayment: null, income_in_advance: null, accrued_expense: null, accrued_income: null } as SpreadWorksheet["posted"];
  for (const kind of SPREAD_KINDS) {
    const account = settings[kind];
    const worksheet = sum(items.filter((item) => item.kind === kind).map((item) => dec(item.left)));
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
  return { ready: SPREAD_KINDS.every((kind) => settings[kind] !== null), settings, items, tieOut, posted };
}
