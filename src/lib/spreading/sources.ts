import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { getPeriodControls } from "@/lib/ledger/period-controls";
import { dec, isPositive, toFixedString } from "@/lib/money/decimal";
import type { SpreadKind } from "@/lib/spreading/rules";
import type { TrackingTags } from "@/lib/tracking/service";

/**
 * "Spread this" on an approved bill or invoice line, or a posted bank
 * transaction line (examples SW15-SW17, SW19), and the line an accrual was
 * waiting for (SW20). The line stays coded to its expense or income account;
 * one journal on its date moves its amount without GST into the kind's
 * balance sheet account.
 */

export type SourceKind = "bill" | "invoice" | "bank";

/** The column on spread_items that holds each kind of line. */
export const SOURCE_COLUMN: Record<SourceKind, string> = { bill: "bill_line_id", invoice: "invoice_line_id", bank: "bank_line_id" };

export type SourceLine = {
  sourceKind: SourceKind;
  lineId: string;
  documentId: string;
  /** A bill or spend money line is a cost; an invoice or receive money line is income. */
  isCost: boolean;
  /** What "Spread this" makes of it: a cost paid in advance, or income in advance. */
  kind: SpreadKind;
  /** The accrual kind it could be the bill or invoice for (SW20). */
  accrualKind: SpreadKind;
  /** e.g. "Bill INS-778 from FMG", "Invoice INV-0042". */
  label: string;
  date: string;
  description: string;
  /** Without GST: what the line put on its account. */
  amount: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  tracking: TrackingTags;
  contactId: string | null;
  /** The item already spreading this line, if any. */
  itemId: string | null;
  /** Why it can't be spread, in words for the screen; null when it can. */
  reason: string | null;
};

type LineRow = {
  line_id: string;
  document_id: string;
  status: string;
  date: string;
  number: string | null;
  contact_id: string | null;
  contact_name: string | null;
  doc_kind: string | null;
  currency_code: string;
  is_opening_balance: boolean;
  description: string;
  net_amount: string;
  tracking: TrackingTags | null;
  account_id: string;
  account_code: string;
  account_name: string;
  account_class: string;
  item_id: string | null;
};

const QUERIES: Record<SourceKind, string> = {
  bill: `select l.id::text as line_id, d.id::text as document_id, d.status, to_char(d.bill_date, 'YYYY-MM-DD') as date, d.supplier_invoice_number as number,
       d.contact_id::text, c.name as contact_name, null::text as doc_kind, d.currency_code, d.is_opening_balance, l.description, l.net_amount::text, l.tracking,
       a.id::text as account_id, a.code as account_code, a.name as account_name, a.account_class,
       (select i.id::text from spread_items i where i.bill_line_id = l.id and i.removed_at is null) as item_id
     from bill_lines l join bills d on d.id = l.bill_id join contacts c on c.id = d.contact_id join accounts a on a.id = l.account_id`,
  invoice: `select l.id::text as line_id, d.id::text as document_id, d.status, to_char(d.invoice_date, 'YYYY-MM-DD') as date, d.invoice_number as number,
       d.contact_id::text, c.name as contact_name, null::text as doc_kind, d.currency_code, d.is_opening_balance, l.description, l.net_amount::text, l.tracking,
       a.id::text as account_id, a.code as account_code, a.name as account_name, a.account_class,
       (select i.id::text from spread_items i where i.invoice_line_id = l.id and i.removed_at is null) as item_id
     from sales_invoice_lines l join sales_invoices d on d.id = l.invoice_id join contacts c on c.id = d.contact_id join accounts a on a.id = l.account_id`,
  bank: `select l.id::text as line_id, d.id::text as document_id, d.status, to_char(d.transaction_date, 'YYYY-MM-DD') as date, nullif(d.reference, '') as number,
       d.contact_id::text, c.name as contact_name, d.kind as doc_kind, d.currency_code, false as is_opening_balance, l.description, l.net_amount::text, l.tracking,
       a.id::text as account_id, a.code as account_code, a.name as account_name, a.account_class,
       (select i.id::text from spread_items i where i.bank_line_id = l.id and i.removed_at is null) as item_id
     from bank_transaction_lines l join bank_transactions d on d.id = l.bank_transaction_id left join contacts c on c.id = d.contact_id join accounts a on a.id = l.account_id`,
};

const WHAT: Record<SourceKind, string> = { bill: "bill", invoice: "invoice", bank: "bank transaction" };

const DOCUMENT_COLUMN: Record<SourceKind, string> = { bill: "l.bill_id", invoice: "l.invoice_id", bank: "l.bank_transaction_id" };

/** How a bill, invoice or bank transaction is named on the worksheet and in the move's journal. */
export function sourceLabel(sourceKind: SourceKind, row: { documentId: string; number: string | null; contactName: string | null; docKind: string | null; date: string | null }): string {
  if (sourceKind === "bill") return `Bill ${row.number ? `${row.number} ` : ""}from ${row.contactName}`;
  if (sourceKind === "invoice") return `Invoice ${row.number ?? `#${row.documentId}`}`;
  return `${row.docKind === "receive" ? "Money received" : "Money spent"}${row.date ? ` ${row.date}` : ""}${row.contactName ? `, ${row.contactName}` : ""}`;
}

function toSourceLine(tx: OrgTx, sourceKind: SourceKind, row: LineRow): SourceLine {
  const what = WHAT[sourceKind];
  const isCost = sourceKind === "bill" || (sourceKind === "bank" && row.doc_kind !== "receive");
  let reason: string | null = null;
  if (row.status !== (sourceKind === "bank" ? "posted" : "approved")) reason = sourceKind === "bank" ? "This bank transaction is voided." : `Approve the ${what} first.`;
  else if (row.is_opening_balance) reason = `An opening balance ${what} has no line to spread.`;
  else if (row.currency_code !== tx.baseCurrency) reason = "Spreading doesn't do foreign currency yet.";
  else if (row.account_class !== (isCost ? "expense" : "revenue")) {
    reason = `This line is coded to ${row.account_code} ${row.account_name}, which isn't ${isCost ? "an expense" : "an income"} account.`;
  } else if (!isPositive(dec(row.net_amount))) reason = "Only a line with an amount above zero can be spread.";
  return {
    sourceKind,
    lineId: row.line_id,
    documentId: row.document_id,
    isCost,
    kind: isCost ? "prepayment" : "income_in_advance",
    accrualKind: isCost ? "accrued_expense" : "accrued_income",
    label: sourceLabel(sourceKind, { documentId: row.document_id, number: row.number, contactName: row.contact_name, docKind: row.doc_kind, date: row.date }),
    date: row.date,
    description: row.description,
    amount: toFixedString(dec(row.net_amount), 2),
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    tracking: row.tracking ?? {},
    contactId: row.contact_id,
    itemId: row.item_id,
    reason,
  };
}

/** The line "Spread this" was pressed on. Throws when it can't be spread. */
export async function loadSourceLine(tx: OrgTx, sourceKind: SourceKind, lineId: string): Promise<SourceLine> {
  const result = await tx.query<LineRow>(`${QUERIES[sourceKind]} where l.id = $1 for update of l`, [lineId]);
  if (!result.rows[0]) throw new NotFoundError(`That ${WHAT[sourceKind]} line wasn't found.`);
  const line = toSourceLine(tx, sourceKind, result.rows[0]);
  if (line.reason) throw new ValidationError(line.reason);
  if (line.itemId) throw new ConflictError("This line is already on the Spreading worksheet.");
  return line;
}

/** A bill's, invoice's or bank transaction's lines, for the "Spread this" card. */
export async function listSourceLines(tx: OrgTx, sourceKind: SourceKind, documentId: string): Promise<SourceLine[]> {
  const result = await tx.query<LineRow>(`${QUERIES[sourceKind]} where ${DOCUMENT_COLUMN[sourceKind]} = $1 order by l.line_order`, [documentId]);
  return result.rows.map((row) => toSourceLine(tx, sourceKind, row));
}

/** Moves the line's amount into the kind's account, on the bill's or invoice's date (SW15, SW16). */
export async function postMove(tx: OrgTx, itemId: string, line: SourceLine, holdingCode: string, description: string): Promise<string> {
  const controls = await getPeriodControls(tx);
  if (controls.lockDate && line.date <= controls.lockDate) {
    throw new ValidationError(
      `${line.label} is dated ${line.date}, and the books are locked up to ${controls.lockDate}, so it can't be moved. Add it on the Spreading worksheet with your own amounts instead.`,
    );
  }
  const amount = line.amount;
  const side = (account: "holding" | "line") => {
    // A cost: Dr the asset / Cr the expense. Income: Dr the income / Cr the liability.
    const debit = line.isCost === (account === "holding");
    return { debitAmount: debit ? amount : "0.00", creditAmount: debit ? "0.00" : amount };
  };
  const text = `${description} - moved to spread (${line.label})`.slice(0, 200);
  // An accrual can be marked as billed, undone and marked again (SW21), so each move for an item has its own key.
  const earlier = await tx.query<{ n: string }>("select count(*)::text as n from ledger_journals where command_source = 'spreading:move' and idempotency_key like $1", [`${itemId}-%`]);
  const moveKey = `${itemId}-${Number(earlier.rows[0].n) + 1}`;
  const posted = await postJournalBody(
    tx,
    "spreading:move",
    moveKey,
    parseJournalBody(tx, {
      postingDate: line.date,
      reference: `SPREAD-MOVE-${itemId}`,
      description: text,
      lines: [
        { accountCode: holdingCode, ...side("holding"), description: text },
        { accountCode: line.accountCode, ...side("line"), description: text, tracking: line.tracking },
      ],
    }),
    { origin: "spreading" },
  );
  return posted.journal.id;
}

/** Puts the amount back on the line's account: the exact reversal on the same date (SW17). */
export async function reverseMove(tx: OrgTx, moveJournalId: string): Promise<string> {
  const original = await getJournal(tx, moveJournalId);
  const posted = await postJournalBody(
    tx,
    "spreading:move-undo",
    moveJournalId,
    parseJournalBody(tx, {
      postingDate: original.postingDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Taken off the Spreading worksheet: ${original.description ?? original.reference}`.slice(0, 500),
      lines: original.lines.map((line) => ({ accountCode: line.accountCode, debitAmount: line.creditAmount, creditAmount: line.debitAmount, description: line.description, tracking: line.tracking })),
    }),
    { origin: "spreading", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  return posted.journal.id;
}
