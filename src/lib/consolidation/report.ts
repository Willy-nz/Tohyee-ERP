import type { AccountClass, AccountType } from "@/lib/accounts/types";
import { RECEIVABLES_SQL } from "@/lib/customers/service";
import { todayIsoDate, parseIsoDate, parseOptionalIsoDate } from "@/lib/dates";
import { type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { financialYearStart } from "@/lib/financial-year";
import { formatDate, formatMoney } from "@/lib/format";
import { listedRates } from "@/lib/fx/rates";
import { add, dec, type Decimal, divide, isNegative, isZero, mul, neg, sub, toFixedString, ZERO_DECIMAL, abs } from "@/lib/money/decimal";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";
import { PAYABLES_SQL } from "@/lib/reports/aged-payables";
import { financialYearEndMonth } from "@/lib/reports/financial";
import { listAccountMaps } from "@/lib/consolidation/mapping";
import { type GroupUser, listAdjustments, listBudgetRates, listRateOverrides, requireGroup, rolesOf } from "@/lib/consolidation/groups";
import { membersOn, periodCrossesMembership } from "@/lib/consolidation/membership";
import { roleAtLeast } from "@/lib/auth/roles";
import type {
  ConsolidatedBudgetVsActual,
  ConsolidatedLine,
  ConsolidatedReport,
  ConsolidatedSection,
  ConsolidationGroup,
  ConsolidationMember,
  MonthRates,
  RateKind,
} from "@/lib/consolidation/types";

/**
 * Consolidated reports (CO3-CO11): each member's ledger is read from its own database, translated
 * into the group's currency (the parent's) and added up by account code,
 * with intercompany amounts eliminated.
 *
 * Translation (consolidated exchange rates, IAS 21):
 * - profit and loss: each month at its average rate, the month's amounts
 *   each times the parent's rate on their date, divided by their total;
 * - assets and liabilities: at the current rate, the rate on the report date;
 * - equity accounts: each month's postings at its historical rate (the
 *   average weighted by equity postings);
 * - what's left is the foreign currency translation reserve.
 * Rates come from the parent's exchange rates list (ECB rates when turned
 * on, FX1); a month's rate an admin changed is used instead. Earnings are
 * split by the group's year (the parent's year end), whatever a member's own.
 */

const ASSET_TYPES: AccountType[] = ["bank", "current_asset", "inventory", "fixed_asset", "non_current_asset"];
const LIABILITY_TYPES: AccountType[] = ["credit_card", "current_liability", "non_current_liability"];

/** Where an account sits in the reports. Accounts add up across organisations by code, within one of these. */
type Place = "assets" | "liabilities" | "equity" | "revenue" | "cost_of_sales" | "other_income" | "expenses";

const PLACE_SAID: Record<Place, string> = {
  assets: "an asset",
  liabilities: "a liability",
  equity: "equity",
  revenue: "revenue",
  cost_of_sales: "a cost of sales",
  other_income: "other income",
  expenses: "an expense",
};

function placeOf(account: { accountClass: AccountClass; accountType: AccountType }): Place {
  if (account.accountClass === "asset") return "assets";
  if (account.accountClass === "liability") return "liabilities";
  if (account.accountClass === "equity") return "equity";
  if (account.accountType === "direct_costs") return "cost_of_sales";
  if (account.accountType === "other_income") return "other_income";
  return account.accountClass === "revenue" ? "revenue" : "expenses";
}

type Account = {
  id: string;
  code: string;
  name: string;
  accountClass: AccountClass;
  accountType: AccountType;
  systemKey: string | null;
  /** The parent's account this one is mapped to in the group (CO16): it adds up on that line, whatever its own code. */
  target?: Account;
};
type DayRow = { accountId: string; date: string; debit: Decimal; credit: Decimal };

type Member = {
  record: OrganisationRecord;
  currency: string;
  accounts: Map<string, Account>;
  byCode: Map<string, Account>;
  days: DayRow[];
  intercompanyAccounts: Map<string, string>;
  /** Open receivables (+) and payables (-) with each linked organisation, in the member's currency, at the report date. */
  owed: Map<string, { receivable: Decimal; payable: Decimal }>;
  budget: Array<{ code: string; month: string; amount: Decimal }>;
};

const SCALE = 2;
const money = (value: Decimal) => toFixedString(value, SCALE);
const round = (value: Decimal) => dec(toFixedString(value, SCALE));
const monthOf = (date: string) => `${date.slice(0, 7)}-01`;

async function loadMember(record: OrganisationRecord, user: GroupUser, asAt: string, withBudget: boolean): Promise<Member> {
  return withOrganisationTransaction(
    record,
    { userId: user.id, email: user.email },
    async (tx: OrgTx) => {
      const accounts = await tx.query<{ id: string; code: string; name: string; account_class: AccountClass; account_type: AccountType; system_key: string | null }>(
        "select id::text, code, name, account_class, account_type, system_key from accounts order by code",
      );
      const days = await tx.query<{ account_id: string; date: string; debit: string; credit: string }>(
        `select l.account_id::text, j.posting_date::text as date, sum(l.debit_amount)::text as debit, sum(l.credit_amount)::text as credit
           from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
          where j.posting_date <= $1 group by 1, 2`,
        [asAt],
      );
      const marked = await tx.query<{ account_id: string; counterpart_organisation_id: string }>("select account_id::text, counterpart_organisation_id from intercompany_accounts");
      const linked = await tx.query<{ contact_id: string; counterpart_organisation_id: string }>("select contact_id::text, counterpart_organisation_id from intercompany_contacts");
      const owed = new Map<string, { receivable: Decimal; payable: Decimal }>();
      for (const link of linked.rows) {
        const receivable = await tx.query<{ due: string }>(
          `${RECEIVABLES_SQL} select coalesce(sum(amount_due_base), 0)::text as due from invoices where contact_id = $2`,
          [asAt, link.contact_id],
        );
        const payable = await tx.query<{ due: string }>(`${PAYABLES_SQL} select coalesce(sum(amount_due_base), 0)::text as due from bills_due where contact_id = $2`, [asAt, link.contact_id]);
        owed.set(link.counterpart_organisation_id, { receivable: dec(receivable.rows[0].due), payable: dec(payable.rows[0].due) });
      }
      const budget = withBudget
        ? (
            await tx.query<{ code: string; month: string; amount: string }>(
              `select a.code, b.month::text, b.amount::text from budget_amounts b join budgets g on g.id = b.budget_id join accounts a on a.id = b.account_id
                where g.is_overall`,
            )
          ).rows.map((row) => ({ code: row.code, month: row.month, amount: dec(row.amount) }))
        : [];
      const list = accounts.rows.map((row) => ({ id: row.id, code: row.code, name: row.name, accountClass: row.account_class, accountType: row.account_type, systemKey: row.system_key }));
      return {
        record,
        currency: record.baseCurrency,
        accounts: new Map(list.map((account) => [account.id, account])),
        byCode: new Map(list.map((account) => [account.code.toLowerCase(), account])),
        days: days.rows.map((row) => ({ accountId: row.account_id, date: row.date, debit: dec(row.debit), credit: dec(row.credit) })),
        intercompanyAccounts: new Map(marked.rows.map((row) => [row.account_id, row.counterpart_organisation_id])),
        owed,
        budget,
      };
    },
    { readOnly: true },
  );
}

// ---------------------------------------------------------------- rates

class Translator {
  /** The dates a rate was needed for and the parent's list had none. */
  readonly missing = new Set<string>();
  private readonly weightCache = new Map<string, Decimal | null>();

  constructor(
    private readonly member: Member,
    private readonly groupCurrency: string,
    private readonly parentName: string,
    /** The parent's list for this currency, newest first. */
    private readonly list: Array<{ rate: string; date: string; until?: string | null }>,
    private readonly overrides: Map<string, string>,
  ) {}

  get foreign(): boolean {
    return this.member.currency !== this.groupCurrency;
  }

  rateOn(date: string): Decimal | null {
    if (!this.foreign) return dec("1");
    // As the list is read everywhere else: a rate from a set stops at the end of its period.
    const found = this.list.find((entry) => entry.date <= date && (entry.until == null || date <= entry.until));
    if (!found) {
      this.missing.add(date);
      return null;
    }
    return dec(found.rate);
  }

  /** What's missing, said once for the currency: the earliest date is the one a rate is needed on or before. */
  missingSaid(): string | null {
    const dates = [...this.missing].sort();
    if (dates.length === 0) return null;
    const oldest = this.list.at(-1)?.date;
    const who = `${this.parentName}'s exchange rates list has no ${this.member.currency} rate for ${formatDate(dates[0])}`;
    if (dates.length === 1) return `${who}.`;
    // Every date is before the list starts: one rate dated on or before the first covers them all.
    if (!oldest || dates.every((date) => date < oldest)) {
      return `${who}, or for ${dates.length - 1} later ${dates.length === 2 ? "date" : "dates"} in ${this.member.record.displayName}'s books up to ${formatDate(dates.at(-1)!)}. One ${this.member.currency} rate dated ${formatDate(dates[0])} or earlier covers them all.`;
    }
    return `${who}, or for ${dates.length - 1} other ${dates.length === 2 ? "date" : "dates"} up to ${formatDate(dates.at(-1)!)}.`;
  }

  /** The rate on a date for the balance sheet, or null when the list has none (a report is then refused, never run at 1). */
  currentOrNull(asAt: string): Decimal | null {
    if (!this.foreign) return dec("1");
    const changed = this.overrides.get(`${monthOf(asAt)}|current`);
    return changed ? dec(changed) : this.rateOn(asAt);
  }

  current(asAt: string): Decimal {
    return this.currentOrNull(asAt) ?? dec("1");
  }

  /** The month's average (P&L) or historical (equity) rate: each day's amounts times its rate, over their total. */
  weighted(month: string, kind: "average" | "historical"): Decimal | null {
    if (!this.foreign) return dec("1");
    const changed = this.overrides.get(`${month}|${kind}`);
    if (changed) return dec(changed);
    const key = `${month}|${kind}`;
    if (this.weightCache.has(key)) return this.weightCache.get(key)!;
    const wanted = (account: Account | undefined) =>
      account !== undefined && (kind === "average" ? account.accountClass === "revenue" || account.accountClass === "expense" : account.accountClass === "equity");
    const byDay = new Map<string, Decimal>();
    for (const row of this.member.days) {
      if (monthOf(row.date) !== month || !wanted(this.member.accounts.get(row.accountId))) continue;
      byDay.set(row.date, add(byDay.get(row.date) ?? ZERO_DECIMAL, add(row.debit, row.credit)));
    }
    let weight = ZERO_DECIMAL;
    let total = ZERO_DECIMAL;
    for (const [date, amount] of byDay) {
      const rate = this.rateOn(date);
      if (!rate) continue;
      weight = add(weight, amount);
      total = add(total, mul(amount, rate));
    }
    const result = isZero(weight) ? null : divide(total, weight, 10);
    this.weightCache.set(key, result);
    return result;
  }
}

type Loaded = {
  /** On the report's date: only the members in the group then. */
  group: ConsolidationGroup;
  /** Every stay of every organisation in the group, for the date checks. */
  periods: ConsolidationMember[];
  members: Member[];
  translators: Map<string, Translator>;
  parent: Member;
  yearEndMonth: number;
  /**
   * Codes (lower case) that are different kinds of account in different
   * members: an expense in one, an asset in another. Each kind gets its own
   * line, so neither is left out of its report.
   */
  clashing: Set<string>;
  /** Saved chart maps that can't be used (the account has gone, or isn't the same class any more), a count for each member. */
  staleMaps: Map<string, number>;
};

/** The line an account's amounts go on: its code, or its code and place when the code clashes. */
function keyOf(loaded: { clashing: Set<string> }, mapped: Account): string {
  const account = mapped.target ?? mapped;
  return loaded.clashing.has(account.code.toLowerCase()) ? `${account.code}~${placeOf(account)}` : account.code;
}

function clashingCodes(members: Member[]): Set<string> {
  const places = new Map<string, Set<Place>>();
  for (const member of members) {
    // A mapped account stands where the parent's account does, so it can't clash.
    for (const mapped of member.accounts.values()) {
      const account = mapped.target ?? mapped;
      const code = account.code.toLowerCase();
      places.set(code, (places.get(code) ?? new Set<Place>()).add(placeOf(account)));
    }
  }
  return new Set([...places].filter(([, found]) => found.size > 1).map(([code]) => code));
}

/**
 * The group as it was on `asAt`: the members in it that day,
 * parent first. Someone who can see the group now must also be able to see
 * any organisation that has since left, or the report is refused.
 */
export async function groupOn(user: GroupUser, groupId: unknown, asAt: string): Promise<{ group: ConsolidationGroup; periods: ConsolidationMember[]; current: ConsolidationGroup }> {
  const current = await requireGroup(user, groupId);
  const periods = [...current.members, ...current.formerMembers];
  const onDate = membersOn(periods, asAt);
  if (!onDate.some((member) => member.organisationId === current.parentOrganisationId)) throw new ValidationError("The parent isn't in the group on that date.");
  const roles = await rolesOf(user.id);
  for (const member of onDate) {
    if (current.members.some((item) => item.organisationId === member.organisationId)) continue;
    const role = roles.get(member.organisationId);
    if (!role || role === "report_viewer" || !roleAtLeast(role, "viewer")) {
      throw new ForbiddenError(`You can't see every organisation that was in the group on ${formatDate(asAt)}, so this report can't be shown to you.`);
    }
  }
  const others = onDate
    .filter((member) => member.organisationId !== current.parentOrganisationId)
    .sort((a, b) => a.name.localeCompare(b.name, "en-NZ") || a.organisationId.localeCompare(b.organisationId));
  const members = [...onDate.filter((member) => member.organisationId === current.parentOrganisationId), ...others];
  return { group: { ...current, members }, periods, current };
}

/** Refuses a report whose dates cross the day a member joined or left (example CO13). */
function refuseCrossing(loaded: Loaded, from: string, to: string): void {
  const names = new Map(loaded.periods.map((period) => [period.organisationId, period.name]));
  const problem = periodCrossesMembership(loaded.periods, from, to, (id) => names.get(id) ?? id);
  if (problem) throw new ValidationError(problem);
}

async function load(user: GroupUser, groupId: unknown, asAt: string, withBudget = false): Promise<Loaded> {
  const { group, periods } = await groupOn(user, groupId, asAt);
  const records: OrganisationRecord[] = [];
  for (const member of group.members) records.push((await getOrganisation(member.organisationId))!);
  const members = await Promise.all(records.map((record) => loadMember(record, user, asAt, withBudget)));
  const parentRecord = records.find((record) => record.id === group.parentOrganisationId)!;
  const foreign = [...new Set(members.map((member) => member.currency).filter((code) => code !== group.currencyCode))];
  const { lists, yearEndMonth } = await withOrganisationTransaction(
    parentRecord,
    { userId: user.id, email: user.email },
    async (tx) => ({ lists: await listedRates(tx, foreign), yearEndMonth: await financialYearEndMonth(tx) }),
    { readOnly: true },
  );
  const overrides = await listRateOverrides(group.id);
  const translators = new Map<string, Translator>();
  for (const member of members) {
    const own = new Map(overrides.filter((entry) => entry.currencyCode === member.currency).map((entry) => [`${entry.month}|${entry.kind}`, entry.rate]));
    translators.set(member.record.id, new Translator(member, group.currencyCode, parentRecord.displayName, lists.get(member.currency) ?? [], own));
  }
  const parent = members.find((member) => member.record.id === group.parentOrganisationId)!;
  // Chart mapping (CO16): send each mapped account to the parent's account, when that still fits.
  const staleMaps = new Map<string, number>();
  for (const map of await listAccountMaps(group.id)) {
    const member = members.find((each) => each.record.id === map.organisationId);
    if (!member || member === parent) continue;
    const account = member.accounts.get(map.accountId);
    if (!account) continue;
    const target = parent.accounts.get(map.parentAccountId);
    if (target && target.accountClass === account.accountClass) account.target = target;
    else staleMaps.set(member.record.id, (staleMaps.get(member.record.id) ?? 0) + 1);
  }
  return { group, periods, members, translators, parent, yearEndMonth, clashing: clashingCodes(members), staleMaps };
}

function refuseMissing(loaded: Loaded): void {
  // One sentence a currency, not one a date.
  const missing = [...new Set([...loaded.translators.values()].flatMap((translator) => translator.missingSaid() ?? []))];
  if (missing.length > 0) {
    throw new ValidationError(`${missing.join(" ")} Add the rates in the parent's Exchange rates (ECB rates, when turned on, only reach back about 90 days), or change the month's rate on the Rates tab.`);
  }
}

// ---------------------------------------------------------------- building reports

/** Signed (debit less credit) amounts in the group's currency: per organisation, per account code. */
type Signed = Map<string, Map<string, Decimal>>;

function bump(map: Signed, organisationId: string, code: string, amount: Decimal): void {
  const own = map.get(organisationId) ?? new Map<string, Decimal>();
  own.set(code, add(own.get(code) ?? ZERO_DECIMAL, amount));
  map.set(organisationId, own);
}

/** Each account's translated profit and loss between dates, month by month at the month's average rate. */
function translatedPnl(loaded: { clashing: Set<string> }, member: Member, translator: Translator, from: string | null, to: string): Map<string, Decimal> {
  const byMonth = new Map<string, Decimal>();
  for (const row of member.days) {
    if ((from && row.date < from) || row.date > to) continue;
    const account = member.accounts.get(row.accountId)!;
    if (account.accountClass !== "revenue" && account.accountClass !== "expense") continue;
    const key = `${keyOf(loaded, account)}|${monthOf(row.date)}`;
    byMonth.set(key, add(byMonth.get(key) ?? ZERO_DECIMAL, sub(row.debit, row.credit)));
  }
  const result = new Map<string, Decimal>();
  for (const [key, amount] of byMonth) {
    const [code, month] = key.split("|");
    const rate = translator.weighted(month, "average");
    if (rate === null) continue;
    result.set(code, add(result.get(code) ?? ZERO_DECIMAL, round(mul(amount, rate))));
  }
  return result;
}

function ownPnl(loaded: { clashing: Set<string> }, member: Member, from: string | null, to: string): Map<string, Decimal> {
  const result = new Map<string, Decimal>();
  for (const row of member.days) {
    if ((from && row.date < from) || row.date > to) continue;
    const account = member.accounts.get(row.accountId)!;
    if (account.accountClass !== "revenue" && account.accountClass !== "expense") continue;
    const key = keyOf(loaded, account);
    result.set(key, add(result.get(key) ?? ZERO_DECIMAL, sub(row.debit, row.credit)));
  }
  return result;
}

function natural(accountClass: AccountClass, signed: Decimal): Decimal {
  return accountClass === "asset" || accountClass === "expense" ? signed : neg(signed);
}

/** The account a line stands for: the parent's if it has one, or the first member's that does. */
function classify(loaded: Loaded, key: string): Account | null {
  const [code, place] = key.split("~");
  const found = [loaded.parent, ...loaded.members].map((member) => member.byCode.get(code.toLowerCase())).filter((account): account is Account => account !== undefined);
  return (place ? found.find((account) => placeOf(account) === place) : found[0]) ?? null;
}

/**
 * Says so when a code means different things in different members: split
 * into two lines when they're different kinds of account, added together
 * under one name when they're the same kind.
 */
function codeNotices(loaded: Loaded, sections: ConsolidatedSection[]): string[] {
  const split: string[] = [];
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const entry of sections.flatMap((section) => section.lines)) {
    const code = entry.code.toLowerCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    // An account mapped elsewhere isn't on this line; one mapped here was put here on purpose.
    const held = loaded.members.flatMap((member) => {
      const account = member.byCode.get(code);
      return account && !account.target ? [{ member, account }] : [];
    });
    if (loaded.clashing.has(code)) {
      split.push(`${entry.code} is ${held.map(({ member, account }) => `${account.name} (${PLACE_SAID[placeOf(account)]}) in ${member.record.displayName}`).join(" and ")}`);
      continue;
    }
    const names = new Set(held.map(({ account }) => account.name.trim().toLowerCase()));
    if (names.size > 1) merged.push(`${entry.code} (${held.map(({ member, account }) => `${account.name} in ${member.record.displayName}`).join(", ")})`);
  }
  const stale = [...loaded.staleMaps].map(([id, count]) => `${count} in ${pairName(loaded, id)}`);
  const few = (list: string[]) => `${list.slice(0, 6).join("; ")}${list.length > 6 ? `; and ${list.length - 6} more` : ""}`;
  return [
    ...(stale.length ? [`Some chart mapping no longer fits (${stale.join(", ")}): the parent's account was removed or changed kind. Those accounts are back on their own codes. Check Chart mapping.`] : []),
    ...(split.length ? [`The same code is a different kind of account in different organisations, so each is on its own line: ${few(split)}. Give them different codes to tidy this up.`] : []),
    ...(merged.length ? [`Accounts add up by code. These codes have different names in different organisations and are added together under the first name: ${few(merged)}. If they aren't the same thing, give one a different code.`] : []),
  ];
}

function line(loaded: Loaded, code: string, name: string, accountClass: AccountClass, perOrg: Signed, elims: Map<string, Decimal>, own: Signed | null, key = code): ConsolidatedLine {
  const amounts: Record<string, string> = {};
  let total = ZERO_DECIMAL;
  for (const member of loaded.members) {
    const value = natural(accountClass, perOrg.get(member.record.id)?.get(key) ?? ZERO_DECIMAL);
    amounts[member.record.id] = money(value);
    total = add(total, value);
  }
  const elimination = natural(accountClass, elims.get(key) ?? ZERO_DECIMAL);
  const ownAmounts: Record<string, string> | null = own
    ? Object.fromEntries(loaded.members.filter((member) => member.currency !== loaded.group.currencyCode).map((member) => [member.record.id, money(natural(accountClass, own.get(member.record.id)?.get(key) ?? ZERO_DECIMAL))]))
    : null;
  return { code, name, amounts, ownAmounts, eliminations: money(elimination), consolidated: money(add(total, elimination)) };
}

function sumLines(name: string, lines: ConsolidatedLine[], memberIds: string[], negate: boolean[] = []): ConsolidatedLine {
  const amounts: Record<string, string> = {};
  for (const id of memberIds) {
    amounts[id] = money(lines.reduce((total, entry, index) => (negate[index] ? sub : add)(total, dec(entry.amounts[id] ?? "0")), ZERO_DECIMAL));
  }
  const field = (pick: (entry: ConsolidatedLine) => string) => money(lines.reduce((total, entry, index) => (negate[index] ? sub : add)(total, dec(pick(entry))), ZERO_DECIMAL));
  return { code: "", name, amounts, ownAmounts: null, eliminations: field((entry) => entry.eliminations), consolidated: field((entry) => entry.consolidated) };
}

function sectionOf(loaded: Loaded, key: string, label: string, types: AccountType[], perOrg: Signed, elims: Map<string, Decimal>, own: Signed | null): ConsolidatedSection | null {
  const codes = new Set<string>();
  for (const map of perOrg.values()) for (const code of map.keys()) codes.add(code);
  for (const code of elims.keys()) codes.add(code);
  const lines: ConsolidatedLine[] = [];
  for (const code of [...codes].sort((left, right) => left.localeCompare(right, "en-NZ", { numeric: true }))) {
    const account = classify(loaded, code);
    if (!account || !types.includes(account.accountType)) continue;
    // A clashing code's line belongs to the place in its key, whatever kind the first account found is.
    if (code.includes("~") && placeOf(account) !== code.split("~")[1]) continue;
    const entry = { ...line(loaded, account.code, account.name, account.accountClass, perOrg, elims, own, code), ...(code !== account.code ? { key: code } : {}) };
    if ([...Object.values(entry.amounts), entry.eliminations].every((value) => isZero(dec(value)))) continue;
    lines.push(entry);
  }
  if (lines.length === 0) return null;
  return { key, label, lines, total: sumLines(`Total ${label.toLowerCase()}`, lines, loaded.members.map((member) => member.record.id)) };
}

function pairName(loaded: Loaded, organisationId: string): string {
  return loaded.members.find((member) => member.record.id === organisationId)?.record.displayName ?? organisationId;
}

/** Notices for each pair of organisations whose intercompany amounts don't agree (CO9). */
function differenceNotices(loaded: Loaded, items: Array<{ from: string; to: string; label: string; signed: Decimal }>): string[] {
  const pairs = new Map<string, typeof items>();
  for (const item of items) {
    // Intercompany accounts and what's owed are each compared on their own, so a notice names only what's out.
    const key = [item.from, item.to].sort().join("|") + (item.label.includes("(owed") ? "|owed" : "|accounts");
    pairs.set(key, [...(pairs.get(key) ?? []), item]);
  }
  const notices: string[] = [];
  for (const list of pairs.values()) {
    const difference = list.reduce((total, item) => add(total, item.signed), ZERO_DECIMAL);
    if (isZero(difference)) continue;
    // Books in different currencies: a balance that agreed on the day drifts apart as the rate moves.
    const currencies = [...new Set(list.flatMap((item) => [item.from, item.to]).map((id) => loaded.members.find((member) => member.record.id === id)?.currency ?? ""))].filter(Boolean);
    const drift = currencies.length > 1 ? ` Their books are in different currencies (${currencies.join(" and ")}), so some or all of this can be the exchange rate moving since the amounts were recorded.` : "";
    notices.push(
      `${list.map((item) => `${pairName(loaded, item.from)} ${item.label} ${formatMoney(money(abs(item.signed)))}`).join(" and ")} don't agree (a difference of ${formatMoney(money(abs(difference)))}). Check them.${drift}`,
    );
  }
  return notices;
}

/** Consolidated profit and loss between two dates (CO4, CO8). */
export async function consolidatedProfitAndLoss(user: GroupUser, groupId: unknown, input: { from?: unknown; to?: unknown } = {}): Promise<ConsolidatedReport> {
  const to = parseOptionalIsoDate(input.to, "to") ?? todayIsoDate();
  const loaded = await load(user, groupId, to);
  const yearStart = financialYearStart(to, loaded.yearEndMonth);
  const from = input.from == null || input.from === "" ? yearStart : parseIsoDate(input.from, "from");
  if (from > to) throw new ValidationError("'from' must be on or before 'to'.");
  refuseCrossing(loaded, from, to);
  const perOrg: Signed = new Map();
  const own: Signed = new Map();
  const elims = new Map<string, Decimal>();
  const items: Array<{ from: string; to: string; label: string; signed: Decimal }> = [];
  const memberIds = new Set(loaded.members.map((member) => member.record.id));
  for (const member of loaded.members) {
    const translator = loaded.translators.get(member.record.id)!;
    const amounts = translatedPnl(loaded, member, translator, from, to);
    for (const [code, amount] of amounts) bump(perOrg, member.record.id, code, amount);
    for (const [code, amount] of ownPnl(loaded, member, from, to)) bump(own, member.record.id, code, amount);
    for (const [accountId, counterpart] of member.intercompanyAccounts) {
      const account = member.accounts.get(accountId);
      if (!account || !memberIds.has(counterpart) || (account.accountClass !== "revenue" && account.accountClass !== "expense")) continue;
      const lineKey = keyOf(loaded, account);
      const amount = amounts.get(lineKey) ?? ZERO_DECIMAL;
      if (isZero(amount)) continue;
      elims.set(lineKey, sub(elims.get(lineKey) ?? ZERO_DECIMAL, amount));
      items.push({ from: member.record.id, to: counterpart, label: `${account.code}`, signed: amount });
    }
  }
  for (const adjustment of await listAdjustments(loaded.group.id)) {
    if (adjustment.date < from || adjustment.date > to) continue;
    for (const entry of adjustment.lines) {
      const account = loaded.members.find((member) => member.record.id === entry.organisationId)?.byCode.get(entry.accountCode.toLowerCase());
      if (!account || (account.accountClass !== "revenue" && account.accountClass !== "expense")) continue;
      const lineKey = keyOf(loaded, account);
      elims.set(lineKey, add(elims.get(lineKey) ?? ZERO_DECIMAL, sub(dec(entry.debit), dec(entry.credit))));
    }
  }
  refuseMissing(loaded);
  const ids = loaded.members.map((member) => member.record.id);
  const revenue = sectionOf(loaded, "revenue", "Revenue", ["revenue"], perOrg, elims, own);
  const costOfSales = sectionOf(loaded, "cost_of_sales", "Cost of sales", ["direct_costs"], perOrg, elims, own);
  const otherIncome = sectionOf(loaded, "other_income", "Other income", ["other_income"], perOrg, elims, own);
  const expenses = sectionOf(loaded, "expenses", "Expenses", ["expense", "depreciation"], perOrg, elims, own);
  // Automatic eliminations never change profit: what doesn't agree is put back on its own line (CO9).
  // Adjustments can (unrealised profit, CO12).
  const difference = items.reduce((total, item) => add(total, item.signed), ZERO_DECIMAL);
  const sections = [revenue, costOfSales, otherIncome, expenses].filter((section): section is ConsolidatedSection => section !== null);
  if (!isZero(difference)) {
    const differenceLine: ConsolidatedLine = {
      code: "",
      name: "Intercompany differences (check these)",
      amounts: Object.fromEntries(ids.map((id) => [id, "0.00"])),
      ownAmounts: null,
      eliminations: money(difference),
      consolidated: money(difference),
    };
    sections.push({ key: "intercompany_differences", label: "Intercompany differences", lines: [differenceLine], total: differenceLine });
  }
  const zero = sumLines("", [], ids);
  const gross = sumLines("Gross profit", [revenue?.total ?? zero, costOfSales?.total ?? zero], ids, [false, true]);
  const lastSection = sections.find((section) => section.key === "intercompany_differences");
  const net = sumLines(
    "Net profit",
    [gross, otherIncome?.total ?? zero, expenses?.total ?? zero, ...(lastSection ? [lastSection.total] : [])],
    ids,
    [false, false, true, true],
  );
  return {
    kind: "profit_and_loss",
    group: loaded.group,
    currencyCode: loaded.group.currencyCode,
    from,
    to,
    yearStart,
    sections,
    totals: [gross, net],
    notices: [...differenceNotices(loaded, items), ...codeNotices(loaded, sections)],
  };
}

/** Consolidated balance sheet at a date (CO5-CO7, CO9). */
export async function consolidatedBalanceSheet(user: GroupUser, groupId: unknown, input: { asAt?: unknown } = {}): Promise<ConsolidatedReport> {
  const asAt = parseOptionalIsoDate(input.asAt, "asAt") ?? todayIsoDate();
  const loaded = await load(user, groupId, asAt);
  const yearStart = financialYearStart(asAt, loaded.yearEndMonth);
  const perOrg: Signed = new Map();
  const own: Signed = new Map();
  const elims = new Map<string, Decimal>();
  const items: Array<{ from: string; to: string; label: string; signed: Decimal }> = [];
  const memberIds = new Set(loaded.members.map((member) => member.record.id));
  const RETAINED = "__retained";
  const CURRENT = "__current";
  const RESERVE = "__reserve";
  for (const member of loaded.members) {
    const id = member.record.id;
    const translator = loaded.translators.get(id)!;
    const current = translator.current(asAt);
    const balances = new Map<string, Decimal>();
    const equityByMonth = new Map<string, Decimal>();
    for (const row of member.days) {
      const account = member.accounts.get(row.accountId)!;
      const signed = sub(row.debit, row.credit);
      const lineKey = keyOf(loaded, account);
      if (account.accountClass === "asset" || account.accountClass === "liability") balances.set(lineKey, add(balances.get(lineKey) ?? ZERO_DECIMAL, signed));
      if (account.accountClass === "equity") {
        const key = `${lineKey}|${monthOf(row.date)}`;
        equityByMonth.set(key, add(equityByMonth.get(key) ?? ZERO_DECIMAL, signed));
      }
      if (account.accountClass !== "revenue" && account.accountClass !== "expense") bump(own, id, lineKey, signed);
    }
    let total = ZERO_DECIMAL;
    for (const [code, balance] of balances) {
      const translated = round(mul(balance, current));
      bump(perOrg, id, code, translated);
      total = add(total, translated);
    }
    for (const [key, amount] of equityByMonth) {
      const [code, month] = key.split("|");
      const rate = translator.weighted(month, "historical");
      if (rate === null) continue;
      const translated = round(mul(amount, rate));
      bump(perOrg, id, code, translated);
      total = add(total, translated);
    }
    const prior = [...translatedPnl(loaded, member, translator, null, priorEnd(yearStart)).values()].reduce((sum, value) => add(sum, value), ZERO_DECIMAL);
    const thisYear = [...translatedPnl(loaded, member, translator, yearStart, asAt).values()].reduce((sum, value) => add(sum, value), ZERO_DECIMAL);
    bump(perOrg, id, RETAINED, prior);
    bump(perOrg, id, CURRENT, thisYear);
    total = add(add(total, prior), thisYear);
    // What translation leaves over is the reserve (CO5); nil for a member in the group's currency.
    bump(perOrg, id, RESERVE, neg(total));
    const ownPrior = [...ownPnl(loaded, member, null, priorEnd(yearStart)).values()].reduce((sum, value) => add(sum, value), ZERO_DECIMAL);
    const ownYear = [...ownPnl(loaded, member, yearStart, asAt).values()].reduce((sum, value) => add(sum, value), ZERO_DECIMAL);
    bump(own, id, RETAINED, ownPrior);
    bump(own, id, CURRENT, ownYear);

    // Intercompany accounts with another member, and what's owed to and by them (CO6).
    for (const [accountId, counterpart] of member.intercompanyAccounts) {
      const account = member.accounts.get(accountId);
      if (!account || !memberIds.has(counterpart) || !["asset", "liability", "equity"].includes(account.accountClass)) continue;
      const lineKey = keyOf(loaded, account);
      const amount = perOrg.get(id)?.get(lineKey) ?? ZERO_DECIMAL;
      if (isZero(amount)) continue;
      elims.set(lineKey, sub(elims.get(lineKey) ?? ZERO_DECIMAL, amount));
      items.push({ from: id, to: counterpart, label: account.code, signed: amount });
    }
    const systemKeyOf = (systemKey: string) => {
      const account = [...member.accounts.values()].find((each) => each.systemKey === systemKey);
      return account ? keyOf(loaded, account) : undefined;
    };
    const receivableCode = systemKeyOf("accounts_receivable");
    const payableCode = systemKeyOf("accounts_payable");
    for (const [counterpart, owed] of member.owed) {
      if (!memberIds.has(counterpart)) continue;
      if (receivableCode && !isZero(owed.receivable)) {
        const amount = round(mul(owed.receivable, current));
        elims.set(receivableCode, sub(elims.get(receivableCode) ?? ZERO_DECIMAL, amount));
        items.push({ from: id, to: counterpart, label: `${receivableCode.split("~")[0]} (owed by ${pairName(loaded, counterpart)})`, signed: amount });
      }
      if (payableCode && !isZero(owed.payable)) {
        const amount = neg(round(mul(owed.payable, current)));
        elims.set(payableCode, sub(elims.get(payableCode) ?? ZERO_DECIMAL, amount));
        items.push({ from: id, to: counterpart, label: `${payableCode.split("~")[0]} (owed to ${pairName(loaded, counterpart)})`, signed: amount });
      }
    }
  }
  for (const adjustment of await listAdjustments(loaded.group.id)) {
    if (adjustment.date > asAt) continue;
    for (const entry of adjustment.lines) {
      const account = loaded.members.find((member) => member.record.id === entry.organisationId)?.byCode.get(entry.accountCode.toLowerCase());
      if (!account) continue;
      const signed = sub(dec(entry.debit), dec(entry.credit));
      const key = account.accountClass === "revenue" || account.accountClass === "expense" ? (adjustment.date >= yearStart ? CURRENT : RETAINED) : keyOf(loaded, account);
      elims.set(key, add(elims.get(key) ?? ZERO_DECIMAL, signed));
    }
  }
  refuseMissing(loaded);
  const ids = loaded.members.map((member) => member.record.id);
  const difference = items.reduce((total, item) => add(total, item.signed), ZERO_DECIMAL);
  const assets = sectionOf(loaded, "assets", "Assets", ASSET_TYPES, perOrg, elims, own);
  const liabilities = sectionOf(loaded, "liabilities", "Liabilities", LIABILITY_TYPES, perOrg, elims, own);
  const equity = sectionOf(loaded, "equity", "Equity", ["equity"], perOrg, elims, own);
  const special = (key: string, name: string) => line(loaded, "", name, "equity", perOrg, elims, own, key);
  const equityLines = [
    ...(equity?.lines ?? []),
    special(RETAINED, "Retained earnings (previous years)"),
    special(CURRENT, "Current year earnings"),
    { ...special(RESERVE, "Foreign currency translation reserve"), ownAmounts: null },
  ];
  // What doesn't agree is put back on its own line (CO9): an asset when it's a debit, a liability when a credit.
  const differenceLine = (accountClass: AccountClass): ConsolidatedLine => ({
    code: "",
    name: "Intercompany differences (check these)",
    amounts: Object.fromEntries(ids.map((id) => [id, "0.00"])),
    ownAmounts: null,
    eliminations: money(natural(accountClass, difference)),
    consolidated: money(natural(accountClass, difference)),
  });
  const assetLines = [...(assets?.lines ?? []), ...(!isZero(difference) && !isNegative(difference) ? [differenceLine("asset")] : [])];
  const liabilityLines = [...(liabilities?.lines ?? []), ...(isNegative(difference) ? [differenceLine("liability")] : [])];
  const sections: ConsolidatedSection[] = [
    { key: "assets", label: "Assets", lines: assetLines, total: sumLines("Total assets", assetLines, ids) },
    { key: "liabilities", label: "Liabilities", lines: liabilityLines, total: sumLines("Total liabilities", liabilityLines, ids) },
    { key: "equity", label: "Equity", lines: equityLines, total: sumLines("Total equity", equityLines, ids) },
  ];
  const liabilitiesAndEquity = sumLines("Total liabilities and equity", [sections[1].total, sections[2].total], ids);
  return {
    kind: "balance_sheet",
    group: loaded.group,
    currencyCode: loaded.group.currencyCode,
    from: null,
    to: asAt,
    yearStart,
    sections,
    totals: [sections[0].total, liabilitiesAndEquity],
    notices: [...differenceNotices(loaded, items), ...codeNotices(loaded, sections)],
  };
}

function priorEnd(yearStart: string): string {
  const date = new Date(`${yearStart}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Consolidated budget vs actual (CO11): each member's overall budget at the month's budget rate, against the consolidated actuals. */
export async function consolidatedBudgetVsActual(user: GroupUser, groupId: unknown, input: { from?: unknown; to?: unknown } = {}): Promise<ConsolidatedBudgetVsActual> {
  const actual = await consolidatedProfitAndLoss(user, groupId, input);
  const loaded = await load(user, groupId, actual.to, true);
  const budgetRates = await listBudgetRates(loaded.group.id);
  const missing = new Set<string>();
  const budgets = new Map<string, Decimal>();
  const fromMonth = monthOf(actual.from!);
  for (const member of loaded.members) {
    for (const entry of member.budget) {
      if (entry.month < fromMonth || entry.month > actual.to) continue;
      const account = member.byCode.get(entry.code.toLowerCase());
      // Only income and costs are in a profit and loss budget.
      if (!account || (account.accountClass !== "revenue" && account.accountClass !== "expense")) continue;
      let rate = dec("1");
      if (member.currency !== loaded.group.currencyCode) {
        const found = budgetRates.find((item) => item.currencyCode === member.currency && item.month === entry.month);
        if (!found) {
          missing.add(`${member.currency} for ${entry.month.slice(0, 7)}`);
          continue;
        }
        rate = dec(found.rate);
      }
      const lineKey = keyOf(loaded, account);
      budgets.set(lineKey, add(budgets.get(lineKey) ?? ZERO_DECIMAL, round(mul(entry.amount, rate))));
    }
  }
  if (missing.size > 0) throw new ValidationError(`Enter the budget exchange rates: ${[...missing].sort().join(", ")}.`);
  const actuals = new Map<string, { name: string; amount: Decimal }>();
  for (const section of actual.sections) {
    for (const entry of section.lines) if (entry.code) actuals.set(entry.key ?? entry.code, { name: entry.name, amount: dec(entry.consolidated) });
  }
  const keys = [...new Set([...actuals.keys(), ...budgets.keys()])].sort((left, right) => left.localeCompare(right, "en-NZ", { numeric: true }));
  // Net profit: income less costs. Adding every line up would add costs to income.
  let net = { actual: ZERO_DECIMAL, budget: ZERO_DECIMAL };
  const lines = keys.map((lineKey) => {
    const amount = actuals.get(lineKey)?.amount ?? ZERO_DECIMAL;
    const budget = budgets.get(lineKey) ?? ZERO_DECIMAL;
    const account = classify(loaded, lineKey);
    const income = account?.accountClass === "revenue";
    net = { actual: (income ? add : sub)(net.actual, amount), budget: (income ? add : sub)(net.budget, budget) };
    return { code: lineKey.split("~")[0], name: actuals.get(lineKey)?.name ?? account?.name ?? lineKey, actual: money(amount), budget: money(budget), variance: money(sub(amount, budget)) };
  });
  // What the intercompany amounts didn't agree by is in the actual net profit, as on the profit and loss.
  const differences = actual.sections.find((section) => section.key === "intercompany_differences");
  if (differences) net = { ...net, actual: sub(net.actual, dec(differences.total.consolidated)) };
  return {
    group: loaded.group,
    currencyCode: loaded.group.currencyCode,
    from: actual.from!,
    to: actual.to,
    lines,
    total: { actual: money(net.actual), budget: money(net.budget), variance: money(sub(net.actual, net.budget)) },
  };
}

/** The consolidation rates for each foreign-currency member, month by month (CO3), as worked out or changed. */
export async function consolidationRates(user: GroupUser, groupId: unknown, input: { from?: unknown; to?: unknown } = {}): Promise<MonthRates[]> {
  const to = parseOptionalIsoDate(input.to, "to") ?? todayIsoDate();
  const loaded = await load(user, groupId, to);
  const fromMonth = monthOf(parseOptionalIsoDate(input.from, "from") ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4, 7)}-01`);
  const overrides = await listRateOverrides(loaded.group.id);
  const rows: MonthRates[] = [];
  for (const member of loaded.members) {
    if (member.currency === loaded.group.currencyCode) continue;
    const translator = loaded.translators.get(member.record.id)!;
    for (let month = fromMonth; month <= monthOf(to); month = nextMonth(month)) {
      const monthEnd = priorEnd(nextMonth(month));
      const changed = overrides.filter((entry) => entry.currencyCode === member.currency && entry.month === month).map((entry) => entry.kind as RateKind);
      const asText = (value: Decimal | null) => (value === null ? null : toFixedString(value, 6));
      rows.push({
        organisationId: member.record.id,
        currencyCode: member.currency,
        month,
        current: asText(translator.currentOrNull(monthEnd > to ? to : monthEnd)),
        average: asText(translator.weighted(month, "average")),
        historical: asText(translator.weighted(month, "historical")),
        changed,
      });
    }
  }
  return rows;
}

function nextMonth(month: string): string {
  const [year, value] = month.split("-").map(Number);
  return value === 12 ? `${year + 1}-01-01` : `${year}-${String(value + 1).padStart(2, "0")}-01`;
}

