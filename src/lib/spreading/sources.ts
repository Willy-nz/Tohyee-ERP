import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { getPeriodControls } from "@/lib/ledger/period-controls";
import { dec, isPositive, toFixedString } from "@/lib/money/decimal";
import type { SpreadKind } from "@/lib/spreading/rules";
import type { TrackingTags } from "@/lib/tracking/service";

/**
 * "Spread this" on an approved bill or invoice line (examples SW15-SW17).
 * The line stays coded to its expense or income account; one journal on the
 * bill's or invoice's date moves its amount without GST into the kind's
 * balance sheet account, and the worksheet spreads it from there.
 */

export type SourceKind = "bill" | "invoice";

export type SourceLine = {
  sourceKind: SourceKind;
  lineId: string;
  documentId: string;
  /** A bill line is a cost paid in advance; an invoice line is income in advance. */
  kind: SpreadKind;
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
  contactId: string;
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
  contact_id: string;
  contact_name: string;
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
       d.contact_id::text, c.name as contact_name, d.currency_code, d.is_opening_balance, l.description, l.net_amount::text, l.tracking,
       a.id::text as account_id, a.code as account_code, a.name as account_name, a.account_class,
       (select i.id::text from spread_items i where i.bill_line_id = l.id and i.removed_at is null) as item_id
     from bill_lines l join bills d on d.id = l.bill_id join contacts c on c.id = d.contact_id join accounts a on a.id = l.account_id`,
  invoice: `select l.id::text as line_id, d.id::text as document_id, d.status, to_char(d.invoice_date, 'YYYY-MM-DD') as date, d.invoice_number as number,
       d.contact_id::text, c.name as contact_name, d.currency_code, d.is_opening_balance, l.description, l.net_amount::text, l.tracking,
       a.id::text as account_id, a.code as account_code, a.name as account_name, a.account_class,
       (select i.id::text from spread_items i where i.invoice_line_id = l.id and i.removed_at is null) as item_id
     from sales_invoice_lines l join sales_invoices d on d.id = l.invoice_id join contacts c on c.id = d.contact_id join accounts a on a.id = l.account_id`,
};

const DOCUMENT_COLUMN: Record<SourceKind, string> = { bill: "l.bill_id", invoice: "l.invoice_id" };

function toSourceLine(tx: OrgTx, sourceKind: SourceKind, row: LineRow): SourceLine {
  const what = sourceKind === "bill" ? "bill" : "invoice";
  let reason: string | null = null;
  if (row.status !== "approved") reason = `Approve the ${what} first.`;
  else if (row.is_opening_balance) reason = `An opening balance ${what} has no line to spread.`;
  else if (row.currency_code !== tx.baseCurrency) reason = "Spreading doesn't do foreign currency yet.";
  else if (row.account_class !== (sourceKind === "bill" ? "expense" : "revenue")) {
    reason = `This line is coded to ${row.account_code} ${row.account_name}, which isn't ${sourceKind === "bill" ? "an expense" : "an income"} account.`;
  } else if (!isPositive(dec(row.net_amount))) reason = "Only a line with an amount above zero can be spread.";
  return {
    sourceKind,
    lineId: row.line_id,
    documentId: row.document_id,
    kind: sourceKind === "bill" ? "prepayment" : "income_in_advance",
    label: sourceKind === "bill" ? `Bill ${row.number ? `${row.number} ` : ""}from ${row.contact_name}` : `Invoice ${row.number ?? `#${row.document_id}`}`,
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
  if (!result.rows[0]) throw new NotFoundError(`That ${sourceKind} line wasn't found.`);
  const line = toSourceLine(tx, sourceKind, result.rows[0]);
  if (line.reason) throw new ValidationError(line.reason);
  if (line.itemId) throw new ConflictError("This line is already on the Spreading worksheet.");
  return line;
}

/** A bill's or invoice's lines that are on an expense or income account, for the "Spread this" card. */
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
    const debit = (line.sourceKind === "bill") === (account === "holding");
    return { debitAmount: debit ? amount : "0.00", creditAmount: debit ? "0.00" : amount };
  };
  const text = `${description} - moved to spread (${line.label})`.slice(0, 200);
  const posted = await postJournalBody(
    tx,
    "spreading:move",
    itemId,
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
export async function reverseMove(tx: OrgTx, itemId: string, moveJournalId: string): Promise<string> {
  const original = await getJournal(tx, moveJournalId);
  const posted = await postJournalBody(
    tx,
    "spreading:move-undo",
    itemId,
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
