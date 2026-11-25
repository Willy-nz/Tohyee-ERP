import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import type { CustomValues } from "@/lib/custom-fields/values";
import { checkManualTags, getJournal, parseJournalBody, postJournalBody, withOriginalCustomFields } from "@/lib/ledger/journals";
import { assertPostingDateAllowed, getPeriodControls } from "@/lib/ledger/period-controls";
import { abs, add, dec, isNegative, isZero, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { monthEndDate, SPREAD_KIND_LABELS, type SpreadKind, spreadPosting } from "@/lib/spreading/rules";
import { getSpreadingSettings, latestPostedMonth, lockWorksheet, parseKind, parseMonth } from "@/lib/spreading/service";
import type { TrackingTags } from "@/lib/tracking/service";
import { asRecord, optionalSource, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Posting a month of the Spreading worksheet (examples SW1-SW14). One journal
 * a kind a month, dated the month end, with a pair of lines for each item.
 * Nothing posts until a person has seen the preview and pressed Post. A
 * kind's months go in order, and its latest month can be undone with the
 * exact reversal on the same date.
 */

const REFERENCE: Record<SpreadKind, string> = {
  prepayment: "PAID",
  income_in_advance: "ADVANCE",
  accrued_expense: "NOTBILLED",
  accrued_income: "NOTINVOICED",
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthName(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

export function spreadReference(kind: SpreadKind, month: string): string {
  return `SPREAD-${REFERENCE[kind]}-${month}`;
}

type JournalLine = { accountCode: string; debitAmount: string; creditAmount: string; description: string; tracking?: TrackingTags; customFields?: CustomValues };

export type MonthPreviewRow = {
  itemId: string;
  description: string;
  lineKind: "share" | "difference";
  amount: string;
  targetCode: string;
  targetName: string;
};

export type MonthPreview = {
  kind: SpreadKind;
  month: string;
  postingDate: string;
  reference: string;
  rows: MonthPreviewRow[];
  total: string;
  journalLines: JournalLine[];
  /** Why it can't post yet, in words for the screen; null when it can. */
  blocked: string | null;
  /** Already posted (the run to undo), or null. */
  runId: string | null;
  /** The item each journal line is for, in order. */
  lineItems: string[];
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

async function activeRun(tx: OrgTx, kind: SpreadKind, month: string): Promise<string | null> {
  const result = await tx.query<{ id: string }>("select id::text from spread_runs where kind = $1 and month = $2 and status = 'active'", [kind, `${month}-01`]);
  return result.rows[0]?.id ?? null;
}

/** What posting a kind's month would do, without doing it. */
export async function previewSpreadMonth(tx: OrgTx, kindInput: unknown, monthInput: unknown): Promise<MonthPreview> {
  const kind = parseKind(kindInput);
  const month = parseMonth(monthInput);
  const settings = await getSpreadingSettings(tx);
  const holding = settings[kind];
  if (!holding) throw new ValidationError("Spreading isn't turned on yet. An admin turns it on under Accounting › Month end.");
  const runId = await activeRun(tx, kind, month);
  const result = await tx.query<{ item_id: string; description: string; line_kind: "share" | "difference"; amount: string; target_code: string; target_name: string; tracking: TrackingTags | null; custom_fields: CustomValues | null }>(
    `select m.item_id::text, i.description, m.line_kind, m.amount::text, t.code as target_code, t.name as target_name, i.tracking, i.custom_fields
       from spread_item_months m join spread_items i on i.id = m.item_id join accounts t on t.id = i.target_account_id
      where i.kind = $1 and m.month = $2 and i.removed_at is null and (($3::bigint is null and m.run_id is null) or m.run_id = $3)
      order by i.id, m.line_kind desc`,
    [kind, `${month}-01`, runId],
  );
  const sides = spreadPosting(kind);
  const journalLines: JournalLine[] = [];
  // Which item each journal line is for, to name it when a rule stops the month.
  const lineItems: string[] = [];
  let total = ZERO_DECIMAL;
  const rows: MonthPreviewRow[] = [];
  for (const row of result.rows) {
    const amount = dec(row.amount);
    rows.push({ itemId: row.item_id, description: row.description, lineKind: row.line_kind, amount: toFixedString(amount, 2), targetCode: row.target_code, targetName: row.target_name });
    total = add(total, amount);
    if (isZero(amount)) continue;
    // A difference can run the other way (a bill that came in under the accrual, SW6): the sides swap.
    const flip = isNegative(amount);
    const size = toFixedString(abs(amount), 2);
    const text = `${row.description}${row.line_kind === "difference" ? " - difference" : ""} - ${monthName(month)}`.slice(0, 200);
    const line = (accountCode: string, side: "debit" | "credit", tags?: { tracking: TrackingTags; customFields: CustomValues }) => {
      const actual = flip ? (side === "debit" ? "credit" : "debit") : side;
      journalLines.push({
        accountCode,
        debitAmount: actual === "debit" ? size : "0.00",
        creditAmount: actual === "credit" ? size : "0.00",
        description: text,
        ...(tags && Object.keys(tags.tracking).length > 0 ? { tracking: tags.tracking } : {}),
        ...(tags && Object.keys(tags.customFields).length > 0 ? { customFields: tags.customFields } : {}),
      });
    };
    // The income or expense line carries the item's tracking and custom fields (SW15, SW25); the balance sheet line has none.
    line(row.target_code, sides.target, { tracking: row.tracking ?? {}, customFields: row.custom_fields ?? {} });
    line(holding.code, sides.holding);
    lineItems.push(row.description, row.description);
  }
  let blocked: string | null = null;
  if (!runId) {
    const earlier = await tx.query<{ month: string }>(
      `select to_char(min(m.month), 'YYYY-MM') as month from spread_item_months m join spread_items i on i.id = m.item_id
        where i.kind = $1 and i.removed_at is null and m.run_id is null and m.month < $2`,
      [kind, `${month}-01`],
    );
    const latest = await latestPostedMonth(tx, kind);
    if (earlier.rows[0]?.month) blocked = `Post ${monthName(earlier.rows[0].month)} first: months go in order.`;
    else if (latest && month < latest) blocked = `${SPREAD_KIND_LABELS[kind]} is already posted to ${monthName(latest)}.`;
    else {
      // A locked month is said up front, and its amounts stay in it (SW10).
      const controls = await getPeriodControls(tx);
      if (controls.lockDate && monthEndDate(month) <= controls.lockDate) {
        blocked = `${monthName(month)} is locked (the books are locked up to ${controls.lockDate}), so it can't be posted. It isn't moved to another month.`;
      }
    }
    // A manual journal's rules for tracking and custom fields apply (SW25); the item is named, not the line.
    if (!blocked && journalLines.length > 0) blocked = await tagProblem(tx, preview(), lineItems, undefined);
  }
  return { ...preview(), blocked };

  function preview(): MonthPreview {
    return { kind, month, postingDate: monthEndDate(month), reference: spreadReference(kind, month), rows, total: toFixedString(total, 2), journalLines, blocked: null, runId, lineItems };
  }
}

function journalInput(preview: MonthPreview, customFields: unknown) {
  return {
    postingDate: preview.postingDate,
    reference: preview.reference,
    description: `${SPREAD_KIND_LABELS[preview.kind]} - ${monthName(preview.month)}`,
    lines: preview.journalLines,
    ...(customFields !== undefined ? { customFields } : {}),
  };
}

/**
 * Why a month's journal would be refused for its tracking or custom fields
 * (a required one missing, say), with the item named in place of "Line 3";
 * null when it's fine. The journal's own required fields are left for
 * posting, where they're filled in.
 */
async function tagProblem(tx: OrgTx, preview: MonthPreview, lineItems: string[], customFields: unknown, posting = false): Promise<string | null> {
  try {
    await checkManualTags(tx, parseJournalBody(tx, journalInput(preview, customFields)));
    return null;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const line = /^Line (\d+)(: | )/.exec(error.message);
    if (line) return `${lineItems[Number(line[1]) - 1] ?? "An item"} ${line[2] === ": " ? "- " : ""}${error.message.slice(line[0].length)} Set it on the item, then post.`;
    // Something the journal itself needs: filled in beside the Post button.
    return posting ? error.message : null;
  }
}

export type SpreadRun = {
  id: string;
  kind: SpreadKind;
  month: string;
  total: string;
  status: "active" | "undone";
  journalId: string | null;
  undoJournalId: string | null;
  createdByEmail: string;
  createdAt: string;
};

export async function getSpreadRun(tx: OrgTx, idInput: unknown): Promise<SpreadRun> {
  const id = requireId(idInput, "runId");
  const result = await tx.query<{ id: string; kind: SpreadKind; month: string; total: string; status: "active" | "undone"; journal_id: string | null; undo_journal_id: string | null; created_by_email: string; created_at: Date | string }>(
    `select id::text, kind, to_char(month, 'YYYY-MM') as month, total::text, status, journal_id::text, undo_journal_id::text, created_by_email, created_at
       from spread_runs where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("That month's posting wasn't found.");
  return {
    id: row.id,
    kind: row.kind,
    month: row.month,
    total: toFixedString(dec(row.total), 2),
    status: row.status,
    journalId: row.journal_id,
    undoJournalId: row.undo_journal_id,
    createdByEmail: row.created_by_email,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Posts a kind's month (bookkeepers; SW1-SW7, SW10, SW14). */
export async function postSpreadMonth(tx: OrgTx, bodyInput: unknown): Promise<{ created: boolean; run: SpreadRun }> {
  const body = asRecord(bodyInput, "body");
  const source = optionalSource(body.source);
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const kind = parseKind(body.kind);
  const month = parseMonth(body.month);
  const hash = requestHash("spread_run", { kind, month, ...(body.customFields !== undefined ? { customFields: body.customFields } : {}) });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from spread_runs where command_source = $1 and idempotency_key = $2", [source, idempotencyKey]);
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "month");
    return { created: false, run: await getSpreadRun(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  await lockWorksheet(tx);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;

  const preview = await previewSpreadMonth(tx, kind, month);
  if (preview.runId) throw new ConflictError(`${SPREAD_KIND_LABELS[kind]} is already posted for ${monthName(month)}.`);
  if (preview.blocked) throw new ConflictError(preview.blocked);
  // A locked month is refused, not moved to another date (SW10).
  await assertPostingDateAllowed(tx, preview.postingDate);
  const next = await tx.query<{ id: string }>("select nextval(pg_get_serial_sequence('spread_runs', 'id'))::text as id");
  const runId = next.rows[0].id;
  let journalId: string | null = null;
  if (preview.journalLines.length > 0) {
    // Checked as a manual journal is (SW25): tags that exist, required ones present, custom field values resolved.
    // Custom fields left out get their defaults, as on a new manual journal.
    const problem = await tagProblem(tx, preview, preview.lineItems, body.customFields, true);
    if (problem) throw new ValidationError(problem);
    const journal = parseJournalBody(tx, journalInput(preview, body.customFields));
    await checkManualTags(tx, journal);
    const posted = await postJournalBody(tx, "spreading:run", runId, journal, { origin: "spreading" });
    journalId = posted.journal.id;
  }
  try {
    await tx.query(
      `insert into spread_runs (id, command_source, idempotency_key, request_hash, kind, month, total, journal_id, created_by_user_id, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10)`,
      [runId, source, idempotencyKey, hash, kind, `${month}-01`, preview.total, journalId, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`${SPREAD_KIND_LABELS[kind]} is already posted for ${monthName(month)}.`);
    throw error;
  }
  await tx.query(
    `update spread_item_months m set run_id = $1 from spread_items i
      where i.id = m.item_id and i.kind = $2 and i.removed_at is null and m.month = $3 and m.run_id is null`,
    [runId, kind, `${month}-01`],
  );
  await writeAuditEvent(tx, { eventType: "spreading.month_posted", entityType: "spread_run", entityId: runId, details: { kind, month, total: preview.total, journalId, items: preview.rows.length } });
  return { created: true, run: await getSpreadRun(tx, runId) };
}

/** Undoes a kind's latest month (bookkeepers; SW14): the exact reversal on the same date, and its amounts wait to be posted again. */
export async function undoSpreadRun(tx: OrgTx, idInput: unknown, bodyInput: unknown): Promise<{ created: boolean; run: SpreadRun }> {
  const id = requireId(idInput, "runId");
  const body = asRecord(bodyInput, "body");
  const source = optionalSource(body.source);
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const hash = requestHash("spread_run_undo", { id });
  const replay = async () => {
    const earlier = await tx.query<{ id: string; hash: string }>("select id::text, undo_request_hash as hash from spread_runs where undo_command_source = $1 and undo_idempotency_key = $2", [source, idempotencyKey]);
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].hash, hash, "undo");
    return { created: false, run: await getSpreadRun(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  await lockWorksheet(tx);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;

  const run = await getSpreadRun(tx, id);
  if (run.status === "undone") throw new ConflictError(`${monthName(run.month)} has already been undone.`);
  const latest = await latestPostedMonth(tx, run.kind);
  if (latest !== run.month) throw new ConflictError(`Only the latest month can be undone. Undo ${monthName(latest ?? run.month)} first.`);
  // An accrual marked as arrived in this month keeps its difference; one marked in a later month can't lose the months it was worked out from.
  const settled = await tx.query<{ description: string }>(
    `select distinct i.description from spread_item_months m join spread_items i on i.id = m.item_id
      where m.run_id = $1 and i.settled_month is not null and i.settled_month > $2 order by i.description`,
    [id, `${run.month}-01`],
  );
  if (settled.rows[0]) {
    throw new ConflictError(`${settled.rows.map((row) => row.description).join(", ")} has had its bill or invoice marked since. That was worked out from this month, so it can't be undone.`);
  }
  const postingDate = monthEndDate(run.month);
  let undoJournalId: string | null = null;
  if (run.journalId) {
    const original = await getJournal(tx, run.journalId);
    const posted = await postJournalBody(
      tx,
      "spreading:undo",
      id,
      withOriginalCustomFields(
        parseJournalBody(tx, {
          postingDate,
          reference: `VOID-${original.reference}`.slice(0, 100),
          description: `Undo of ${SPREAD_KIND_LABELS[run.kind].toLowerCase()} - ${monthName(run.month)}`,
          lines: original.lines.map((line) => ({ accountCode: line.accountCode, debitAmount: line.creditAmount, creditAmount: line.debitAmount, description: line.description, tracking: line.tracking })),
        }),
        original,
      ),
      { origin: "spreading", relatedJournalId: original.id, correctionKind: "reversal" },
    );
    undoJournalId = posted.journal.id;
  } else {
    await assertPostingDateAllowed(tx, postingDate);
  }
  try {
    await tx.query(
      `update spread_runs set status = 'undone', undo_journal_id = $2, undo_command_source = $3, undo_idempotency_key = $4, undo_request_hash = $5,
              undone_by_email = $6, undone_at = now() where id = $1`,
      [id, undoJournalId, source, idempotencyKey, hash, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different undo. Use a new key.");
    throw error;
  }
  await tx.query("update spread_item_months set run_id = null where run_id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "spreading.month_undone", entityType: "spread_run", entityId: id, details: { kind: run.kind, month: run.month, undoJournalId } });
  return { created: true, run: await getSpreadRun(tx, id) };
}
