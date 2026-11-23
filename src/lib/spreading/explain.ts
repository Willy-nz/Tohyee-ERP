import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { dec, neg, sub, sum, toFixedString } from "@/lib/money/decimal";
import type { SpreadKind } from "@/lib/spreading/rules";
import { getSpreadWorksheet, parseKind, type SpreadAccount } from "@/lib/spreading/service";

/**
 * What's behind an "Out by" (example SW24). A kind's account should hold
 * what was coded to it by hand, less what the worksheet has released. So the
 * two lists to match by eye are the entries coded to the account from
 * outside the worksheet, and the worksheet's items that expect one. Items
 * made with "Spread this" bring their own entry, so they're on neither list.
 */

export type SpreadExplainEntry = { journalId: string; date: string; reference: string; description: string | null; amount: string };
export type SpreadExplainItem = { itemId: string | null; description: string; amount: string };

export type SpreadExplain = {
  kind: SpreadKind;
  account: SpreadAccount;
  /** Entries on the account that the worksheet didn't post, newest first, signed the way the account runs. Voided entries and their reversals are left out. */
  outside: SpreadExplainEntry[];
  /** How many more there are than the list shows. */
  outsideMore: number;
  outsideTotal: string;
  /** What the worksheet expects to find coded to the account. */
  expected: SpreadExplainItem[];
  expectedTotal: string;
  /** outsideTotal less expectedTotal: the "Out by". */
  difference: string;
};

const LIST = 200;

export async function explainSpreadDifference(tx: OrgTx, kindInput: unknown): Promise<SpreadExplain> {
  const kind = parseKind(kindInput);
  const worksheet = await getSpreadWorksheet(tx);
  const account = worksheet.settings[kind];
  if (!account) throw new ValidationError("Spreading isn't turned on yet. An admin turns it on under Accounting › Month end.");
  const asset = kind === "prepayment" || kind === "accrued_income";
  const sign = asset ? "l.debit_amount - l.credit_amount" : "l.credit_amount - l.debit_amount";
  // A voided entry and its exact reversal cancel on the account, so neither helps find a difference.
  const where = `l.account_id = $1 and j.origin <> 'spreading'
    and not (j.correction_kind = 'reversal' and j.related_journal_id is not null)
    and not exists (select 1 from ledger_journals r where r.related_journal_id = j.id and r.correction_kind = 'reversal')`;
  const rows = await tx.query<{ journal_id: string; date: string; reference: string; description: string | null; amount: string }>(
    `select j.id::text as journal_id, to_char(j.posting_date, 'YYYY-MM-DD') as date, j.reference, coalesce(nullif(l.description, ''), j.description) as description,
            sum(${sign})::text as amount
       from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
      where ${where}
      group by j.id, j.posting_date, j.reference, coalesce(nullif(l.description, ''), j.description)
     having sum(${sign}) <> 0
      order by j.posting_date desc, j.id desc limit $2`,
    [account.id, LIST + 1],
  );
  const total = await tx.query<{ total: string; entries: string }>(
    `select coalesce(sum(${sign}), 0)::text as total, count(distinct j.id)::text as entries
       from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id where ${where}`,
    [account.id],
  );
  const outside = rows.rows.slice(0, LIST).map((row) => ({ journalId: row.journal_id, date: row.date, reference: row.reference, description: row.description, amount: toFixedString(dec(row.amount), 2) }));

  const expected: SpreadExplainItem[] = [];
  for (const item of worksheet.items.filter((each) => each.kind === kind)) {
    if (kind === "prepayment" || kind === "income_in_advance") {
      // Added on the worksheet: its bill or invoice was to be coded to the account.
      if (!item.source) expected.push({ itemId: item.id, description: item.description, amount: item.amount });
    } else if (item.settledAmount && !item.source) {
      // An accrual marked as arrived by hand: its bill or invoice was to be coded to the account, which takes it back out.
      expected.push({ itemId: item.id, description: `${item.description}: ${kind === "accrued_expense" ? "its bill" : "its invoice"}`, amount: toFixedString(neg(dec(item.settledAmount)), 2) });
    }
  }
  if (kind === "income_in_advance") {
    for (const held of worksheet.shopHeld.filter((row) => row.counted)) expected.push({ itemId: null, description: "Shop orders paid and not sent yet", amount: held.held });
  }
  const outsideTotal = dec(total.rows[0].total);
  const expectedTotal = sum(expected.map((row) => dec(row.amount)));
  return {
    kind,
    account,
    outside,
    outsideMore: Math.max(0, rows.rows.length > LIST ? Number(total.rows[0].entries) - LIST : 0),
    outsideTotal: toFixedString(outsideTotal, 2),
    expected,
    expectedTotal: toFixedString(expectedTotal, 2),
    difference: toFixedString(sub(outsideTotal, expectedTotal), 2),
  };
}
