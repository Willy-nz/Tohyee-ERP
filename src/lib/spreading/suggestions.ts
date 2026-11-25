import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { todayIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { addMonths, monthsBegun, type SpreadKind } from "@/lib/spreading/rules";
import { getSpreadingSettings, latestPostedMonth } from "@/lib/spreading/service";
import { listRecentSourceLines, type SourceKind } from "@/lib/spreading/sources";
import { periodFromText, RECURRING_MONTHS, usualAmount } from "@/lib/spreading/suggest-rules";
import { asRecord, requireString } from "@/lib/validation";

/**
 * Suggestions on the Spreading worksheet (SW26-SW28): things Tohyee has
 * noticed that a person might want to spread or accrue. They're worked out
 * from the books each time and nothing is added until someone accepts one,
 * which adds an ordinary item the ordinary way.
 */

/** A line whose words say it covers more than a month (SW26). Accepting it is "Spread this" with these dates. */
export type LineSuggestion = {
  key: string;
  type: "line";
  sourceKind: SourceKind;
  lineId: string;
  documentId: string;
  kind: SpreadKind;
  /** e.g. "Bill INS-778 from FMG". */
  label: string;
  date: string;
  description: string;
  amount: string;
  accountCode: string;
  accountName: string;
  startDate: string;
  endDate: string;
  months: number;
  /** The words on the line that said so. */
  because: string;
};

/** A supplier who billed an account in each of the last three months and hasn't this month (SW27). Accepting it adds a one-month accrual. */
export type AccrualSuggestion = {
  key: string;
  type: "accrual";
  kind: "accrued_expense";
  contactId: string;
  contactName: string;
  accountCode: string;
  accountName: string;
  month: string;
  /** The average of the last three months, without GST. */
  amount: string;
  /** What each of those months was, oldest first. */
  history: Array<{ month: string; amount: string }>;
  /** What accepting it would call the item. */
  description: string;
};

export type SpreadSuggestions = {
  /** The month missing bills are looked for in: the next one to post for costs not billed yet. */
  month: string;
  lines: LineSuggestion[];
  accruals: AccrualSuggestion[];
};

/** How far back a bill, invoice or bank line is still worth suggesting. */
const LOOK_BACK_MONTHS = 4;
const MAX_EACH = 25;

function cents(amount: string): number {
  return Math.round(Number(amount) * 100);
}

function money(value: number): string {
  return (value / 100).toFixed(2);
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-NZ", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** The month being closed: after the last one posted for costs not billed yet (never past this month), or last month when none has been. */
async function monthToLookAt(tx: OrgTx, today: string): Promise<string> {
  const thisMonth = today.slice(0, 7);
  const latest = await latestPostedMonth(tx, "accrued_expense");
  if (!latest) return addMonths(thisMonth, -1);
  const next = addMonths(latest, 1);
  return next > thisMonth ? thisMonth : next;
}

async function lineSuggestions(tx: OrgTx, today: string, ready: (kind: SpreadKind) => boolean): Promise<LineSuggestion[]> {
  const since = `${addMonths(today.slice(0, 7), -LOOK_BACK_MONTHS)}-01`;
  const found: LineSuggestion[] = [];
  for (const sourceKind of ["bill", "invoice", "bank"] as const) {
    for (const line of await listRecentSourceLines(tx, sourceKind, since)) {
      if (!ready(line.kind)) continue;
      const period = periodFromText(line.description, line.date);
      if (!period) continue;
      found.push({
        key: `line:${sourceKind}:${line.lineId}`,
        type: "line",
        sourceKind,
        lineId: line.lineId,
        documentId: line.documentId,
        kind: line.kind,
        label: line.label,
        date: line.date,
        description: line.description,
        amount: line.amount,
        accountCode: line.accountCode,
        accountName: line.accountName,
        startDate: period.startDate,
        endDate: period.endDate,
        months: monthsBegun(period.startDate, period.endDate).length,
        because: period.because,
      });
    }
  }
  return found.sort((left, right) => right.date.localeCompare(left.date) || left.key.localeCompare(right.key));
}

async function accrualSuggestions(tx: OrgTx, month: string): Promise<AccrualSuggestion[]> {
  const from = `${addMonths(month, -RECURRING_MONTHS)}-01`;
  const until = `${addMonths(month, 1)}-01`;
  const billed = await tx.query<{ contact_id: string; contact_name: string; account_id: string; code: string; name: string; month: string; amount: string }>(
    `select d.contact_id::text, c.name as contact_name, a.id::text as account_id, a.code, a.name, to_char(d.bill_date, 'YYYY-MM') as month, sum(l.net_amount)::text as amount
       from bill_lines l join bills d on d.id = l.bill_id join contacts c on c.id = d.contact_id join accounts a on a.id = l.account_id
      where d.status = 'approved' and not d.is_opening_balance and d.currency_code = $1 and a.account_class = 'expense' and a.is_active
        and d.bill_date >= $2::date and d.bill_date < $3::date
      group by d.contact_id, c.name, a.id, a.code, a.name, to_char(d.bill_date, 'YYYY-MM')`,
    [tx.baseCurrency, from, until],
  );
  const pairs = new Map<string, { row: (typeof billed.rows)[number]; byMonth: Map<string, number> }>();
  for (const row of billed.rows) {
    const key = `${row.contact_id}:${row.account_id}`;
    const pair = pairs.get(key) ?? { row, byMonth: new Map<string, number>() };
    pair.byMonth.set(row.month, cents(row.amount));
    pairs.set(key, pair);
  }
  // Already accrued for the month by hand: nothing to suggest.
  const accrued = await tx.query<{ key: string }>(
    `select distinct i.contact_id::text || ':' || i.target_account_id::text as key
       from spread_items i join spread_item_months m on m.item_id = i.id
      where i.kind = 'accrued_expense' and i.removed_at is null and i.contact_id is not null and m.month = $1::date`,
    [`${month}-01`],
  );
  const have = new Set(accrued.rows.map((row) => row.key));
  const found: AccrualSuggestion[] = [];
  for (const [pairKey, { row, byMonth }] of pairs) {
    if (have.has(pairKey)) continue;
    const usual = usualAmount(byMonth, month);
    if (usual === null) continue;
    found.push({
      key: `accrual:${row.contact_id}:${row.account_id}:${month}`,
      type: "accrual",
      kind: "accrued_expense",
      contactId: row.contact_id,
      contactName: row.contact_name,
      accountCode: row.code,
      accountName: row.name,
      month,
      amount: money(usual),
      history: Array.from({ length: RECURRING_MONTHS }, (_, index) => addMonths(month, index - RECURRING_MONTHS)).map((each) => ({ month: each, amount: money(byMonth.get(each) ?? 0) })),
      description: `${row.name}, ${row.contact_name}, ${monthLabel(month)} (no bill yet)`.slice(0, 200),
    });
  }
  return found.sort((left, right) => left.contactName.localeCompare(right.contactName) || left.accountCode.localeCompare(right.accountCode, "en-NZ", { numeric: true }));
}

/** What Tohyee has noticed. Anyone who can see the worksheet. */
export async function listSpreadSuggestions(tx: OrgTx, today: string = todayIsoDate()): Promise<SpreadSuggestions> {
  const settings = await getSpreadingSettings(tx);
  const month = await monthToLookAt(tx, today);
  const dismissed = new Set((await tx.query<{ suggestion_key: string }>("select suggestion_key from spread_suggestion_dismissals")).rows.map((row) => row.suggestion_key));
  const keep = <T extends { key: string }>(list: T[]) => list.filter((each) => !dismissed.has(each.key)).slice(0, MAX_EACH);
  return {
    month,
    lines: keep(await lineSuggestions(tx, today, (kind) => settings[kind] !== null)),
    accruals: settings.accrued_expense ? keep(await accrualSuggestions(tx, month)) : [],
  };
}

/** "Not this one" (SW28): the suggestion doesn't come back. Bookkeepers and above. Nothing in the books changes. */
export async function dismissSpreadSuggestion(tx: OrgTx, bodyInput: unknown): Promise<void> {
  const key = requireString(asRecord(bodyInput, "body").key, "key", { maxLength: 120 });
  if (!/^(line:(bill|invoice|bank):\d{1,18}|accrual:\d{1,18}:\d{1,18}:\d{4}-\d{2})$/.test(key)) throw new ValidationError("That isn't a suggestion.");
  const added = await tx.query("insert into spread_suggestion_dismissals (suggestion_key, dismissed_by_email) values ($1, $2) on conflict (suggestion_key) do nothing", [key, tx.actor.email]);
  if (added.rowCount) await writeAuditEvent(tx, { eventType: "spread_suggestion.dismissed", entityType: "spread_suggestion", entityId: key, details: {} });
}
