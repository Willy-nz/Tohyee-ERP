import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  claimDueDate,
  claimTiming,
  FUEL_TYPES,
  FUEL_USER_KIND_KEYS,
  type FuelType,
  type FuelUserKind,
  guessFuelType,
  guessLitres,
  isFuelAccountName,
  isQuarterEnd,
  previousQuarterEnd,
  quarterStart,
  type RefundResult,
  workOutRefund,
} from "@/lib/farming/fuel-refund-rules";
import { requireFarming } from "@/lib/farming/paddocks";
import { add, cmp, dec, type Decimal, parseDecimalInput, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { optionalBoolean, requireId, requireOneOf, requireString } from "@/lib/validation";

/*
 * The fuel excise refund (examples FUEL1-FUEL12; following common practice,
 * not yet reviewed): petrol and diesel from the books for a quarter, the tank,
 * each user's share, and the refund for NZTA's MR70. Nothing posts.
 */

/** The books' figures: bookkeepers and owners only (FUEL2). */
async function requireFuelRefund(tx: OrgTx): Promise<void> {
  await requireFarming(tx);
  if (tx.actor.userId && !(tx.actor.role && roleAtLeast(tx.actor.role, "bookkeeper"))) {
    throw new ForbiddenError("The fuel refund uses the books, so it needs the bookkeeper role or higher.");
  }
}

export type FuelLine = {
  source: "bill_line" | "bank_line" | "manual";
  sourceId: string;
  date: string;
  supplier: string | null;
  description: string;
  accountName: string | null;
  amount: string | null;
  fuelType: FuelType;
  /** Tohyee's guess, before the farmer's choice. */
  guessedType: FuelType;
  litres: string | null;
  litresTyped: boolean;
};

export type FuelUser = { id: string; name: string; kind: FuelUserKind; roadLicensed: boolean; active: boolean };

export type FuelQuarter = {
  quarterEnd: string;
  start: string;
  dueDate: string;
  timing: ReturnType<typeof claimTiming>;
  opening: string;
  openingTyped: boolean;
  closing: string;
  petrol: FuelLine[];
  diesel: FuelLine[];
  unsure: FuelLine[];
  notFuel: FuelLine[];
  dieselLitres: string;
  users: Array<FuelUser & { percent: string }>;
  /** Petrol lines with no litres: the claim can't be worked out (FUEL3). */
  missingLitres: number;
  result: RefundResult | null;
  notes: string[];
};

type LineRow = {
  source: "bill_line" | "bank_line";
  source_id: string;
  date: string;
  supplier: string | null;
  description: string;
  account_name: string;
  quantity: string;
  amount: string;
  fuel_type: FuelType | null;
  litres: string | null;
};

const EXPLICIT = /\b(petrol|unleaded|ulp|diesel)\b/i;

async function linesFor(tx: OrgTx, start: string, end: string): Promise<FuelLine[]> {
  const rows = await tx.query<LineRow>(
    `select * from (
     select 'bill_line' as source, l.id as line_id, l.id::text as source_id, b.bill_date::text as date, c.name as supplier, l.description, a.name as account_name,
            l.quantity::text, l.line_amount::text as amount, ch.fuel_type, ch.litres::text
       from bill_lines l join bills b on b.id = l.bill_id join accounts a on a.id = l.account_id join contacts c on c.id = b.contact_id
       left join fuel_refund_line_choices ch on ch.source = 'bill_line' and ch.source_id = l.id
      where b.status = 'approved' and b.bill_date between $1 and $2
     union all
     select 'bank_line', l.id, l.id::text, t.transaction_date::text, c.name, l.description, a.name, l.quantity::text, l.line_amount::text, ch.fuel_type, ch.litres::text
       from bank_transaction_lines l join bank_transactions t on t.id = l.bank_transaction_id join accounts a on a.id = l.account_id join contacts c on c.id = t.contact_id
       left join fuel_refund_line_choices ch on ch.source = 'bank_line' and ch.source_id = l.id
      where t.kind = 'spend' and t.status = 'posted' and t.transaction_date between $1 and $2
     ) fuel order by fuel.date, fuel.source, fuel.line_id`,
    [start, end],
  );
  const lines: FuelLine[] = [];
  for (const row of rows.rows) {
    const onFuelAccount = isFuelAccountName(row.account_name);
    if (!onFuelAccount && !EXPLICIT.test(row.description) && !row.fuel_type) continue;
    const guessed = guessFuelType(row.description);
    lines.push({
      source: row.source,
      sourceId: row.source_id,
      date: row.date,
      supplier: row.supplier,
      description: row.description,
      accountName: row.account_name,
      amount: toFixedString(dec(row.amount), 2),
      fuelType: row.fuel_type ?? guessed,
      guessedType: guessed,
      litres: row.litres !== null ? toFixedString(dec(row.litres), 2) : guessLitres(row.description, row.quantity),
      litresTyped: row.litres !== null,
    });
  }
  const manual = await tx.query<{ id: string; bought_on: string; description: string; fuel_type: "petrol" | "diesel"; litres: string }>(
    "select m.id::text, m.bought_on::text, m.description, m.fuel_type, m.litres::text from fuel_refund_manual m where m.bought_on between $1 and $2 order by m.bought_on, m.id",
    [start, end],
  );
  for (const row of manual.rows) {
    lines.push({ source: "manual", sourceId: row.id, date: row.bought_on, supplier: null, description: row.description, accountName: null, amount: null, fuelType: row.fuel_type, guessedType: row.fuel_type, litres: toFixedString(dec(row.litres), 2), litresTyped: true });
  }
  return lines;
}

async function users(tx: OrgTx): Promise<FuelUser[]> {
  const rows = await tx.query<{ id: string; name: string; kind: string; road_licensed: boolean; is_active: boolean }>("select u.id::text, u.name, u.kind, u.road_licensed, u.is_active from fuel_refund_users u order by u.is_active desc, u.name, u.id");
  return rows.rows.map((row) => ({ id: row.id, name: row.name, kind: (FUEL_USER_KIND_KEYS as string[]).includes(row.kind) ? (row.kind as FuelUserKind) : "other", roadLicensed: row.road_licensed, active: row.is_active }));
}

/** Each user's share for a quarter: its own, or the latest quarter before it that has shares (FUEL6). */
async function sharesFor(tx: OrgTx, end: string): Promise<Map<string, Decimal>> {
  const rows = await tx.query<{ user_id: string; percent: string }>(
    `select user_id::text, percent::text from fuel_refund_shares
      where quarter_end = (select max(quarter_end) from fuel_refund_shares where quarter_end <= $1)`,
    [end],
  );
  return new Map(rows.rows.map((row) => [row.user_id, dec(row.percent)]));
}

/** The closing tank of the quarter before, worked back while openings aren't typed (FUEL5). */
async function tankFor(tx: OrgTx, end: string): Promise<{ opening: Decimal; openingTyped: boolean; closing: Decimal }> {
  const here = await tx.query<{ opening_litres: string | null; closing_litres: string | null }>("select opening_litres::text, closing_litres::text from fuel_refund_quarters where quarter_end = $1", [end]);
  const row = here.rows[0];
  const closing = row?.closing_litres ? dec(row.closing_litres) : ZERO_DECIMAL;
  if (row?.opening_litres) return { opening: dec(row.opening_litres), openingTyped: true, closing };
  const before = await tx.query<{ closing_litres: string | null }>("select closing_litres::text from fuel_refund_quarters where quarter_end = $1", [previousQuarterEnd(end)]);
  return { opening: before.rows[0]?.closing_litres ? dec(before.rows[0].closing_litres) : ZERO_DECIMAL, openingTyped: false, closing };
}

function requireQuarter(input: unknown): string {
  const end = parseIsoDate(input, "Quarter");
  if (!isQuarterEnd(end)) throw new ValidationError("A quarter ends on 31 March, 30 June, 30 September or 31 December.");
  return end;
}

/** A quarter's petrol, diesel, tank, shares and refund (FUEL2-FUEL9). */
export async function fuelQuarter(tx: OrgTx, input: { quarterEnd: unknown; today?: string }): Promise<FuelQuarter> {
  await requireFuelRefund(tx);
  const end = requireQuarter(input.quarterEnd);
  const start = quarterStart(end);
  const today = input.today ?? todayIsoDate();
  const lines = await linesFor(tx, start, end);
  const petrol = lines.filter((line) => line.fuelType === "petrol");
  const diesel = lines.filter((line) => line.fuelType === "diesel");
  const tank = await tankFor(tx, end);
  const shares = await sharesFor(tx, end);
  const everyone = await users(tx);
  const shown = everyone.filter((user) => user.active || shares.has(user.id)).map((user) => ({ ...user, percent: toFixedString(shares.get(user.id) ?? ZERO_DECIMAL, 2) }));
  const missingLitres = petrol.filter((line) => line.litres === null).length;
  const notes: string[] = [];
  const timing = claimTiming(end, today);
  if (timing === "late") notes.push(`This claim was due by ${claimDueDate(end)}. NZTA takes 10% off a late claim.`);
  if (timing === "too_old") notes.push("This quarter ended more than two years ago, so it can't be claimed.");
  if (timing === "not_ended") notes.push("This quarter hasn't ended yet: the figures can still change.");
  notes.push("NZTA needs you registered before your first claim.");
  const result =
    missingLitres > 0
      ? null
      : workOutRefund({
          opening: tank.opening,
          closing: tank.closing,
          petrolLitres: petrol.map((line) => dec(line.litres as string)),
          shares: shown.map((user) => ({ percent: dec(user.percent), roadLicensed: user.roadLicensed })),
        });
  return {
    quarterEnd: end,
    start,
    dueDate: claimDueDate(end),
    timing,
    opening: toFixedString(tank.opening, 2),
    openingTyped: tank.openingTyped,
    closing: toFixedString(tank.closing, 2),
    petrol,
    diesel,
    unsure: lines.filter((line) => line.fuelType === "unsure"),
    notFuel: lines.filter((line) => line.fuelType === "not_fuel"),
    dieselLitres: toFixedString(diesel.reduce((sum, line) => (line.litres ? add(sum, dec(line.litres)) : sum), ZERO_DECIMAL), 2),
    users: shown,
    missingLitres,
    result,
    notes,
  };
}

/** What a line from the books is, and its litres (FUEL2, FUEL3). Blank litres go back to Tohyee's guess. */
export async function chooseFuelLine(tx: OrgTx, input: { source: unknown; sourceId: unknown; fuelType: unknown; litres?: unknown }): Promise<void> {
  await requireFuelRefund(tx);
  const source = requireOneOf(input.source, "source", ["bill_line", "bank_line"] as const);
  const sourceId = requireId(input.sourceId, "sourceId");
  const fuelType = requireOneOf(input.fuelType, "Fuel", FUEL_TYPES);
  const table = source === "bill_line" ? "bill_lines" : "bank_transaction_lines";
  const exists = await tx.query(`select 1 from ${table} where id = $1`, [sourceId]);
  if (!exists.rowCount) throw new NotFoundError("That line wasn't found.");
  const litres = input.litres === undefined || input.litres === null || input.litres === "" ? null : parseDecimalInput(input.litres, "Litres", { maxScale: 2 });
  await tx.query(
    `insert into fuel_refund_line_choices (source, source_id, fuel_type, litres, updated_by_email) values ($1, $2, $3, $4, $5)
     on conflict (source, source_id) do update set fuel_type = excluded.fuel_type, litres = excluded.litres, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [source, sourceId, fuelType, litres, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.fuel_line_chosen", entityType: source, entityId: sourceId, details: { fuelType, litres } });
}

/** Petrol or diesel bought without a line in the books (FUEL4). */
export async function addManualFuel(tx: OrgTx, input: Record<string, unknown>): Promise<void> {
  await requireFuelRefund(tx);
  const boughtOn = parseIsoDate(input.boughtOn, "Date");
  const description = requireString(input.description, "Description", { maxLength: 200 }).trim();
  if (!description) throw new ValidationError("Description is required.");
  const fuelType = requireOneOf(input.fuelType, "Fuel", ["petrol", "diesel"] as const);
  const litres = parseDecimalInput(input.litres, "Litres", { maxScale: 2 });
  const row = await tx.query<{ id: string }>("insert into fuel_refund_manual (bought_on, description, fuel_type, litres, created_by_email) values ($1, $2, $3, $4, $5) returning id::text", [boughtOn, description, fuelType, litres, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.fuel_manual_added", entityType: "fuel_refund_manual", entityId: row.rows[0].id, details: { boughtOn, fuelType, litres } });
}

export async function removeManualFuel(tx: OrgTx, input: { id: unknown }): Promise<void> {
  await requireFuelRefund(tx);
  const id = requireId(input.id, "id");
  const removed = await tx.query("delete from fuel_refund_manual where id = $1", [id]);
  if (!removed.rowCount) throw new NotFoundError("That entry wasn't found.");
  await writeAuditEvent(tx, { eventType: "farming.fuel_manual_removed", entityType: "fuel_refund_manual", entityId: id, details: {} });
}

/** Adds or changes something that uses petrol (FUEL6). */
export async function saveFuelUser(tx: OrgTx, input: Record<string, unknown>): Promise<FuelUser[]> {
  await requireFuelRefund(tx);
  const name = requireString(input.name, "Name", { maxLength: 100 }).trim();
  if (!name) throw new ValidationError("Name is required.");
  const kind = requireOneOf(input.kind, "Kind", FUEL_USER_KIND_KEYS);
  const roadLicensed = optionalBoolean(input.roadLicensed, "roadLicensed") ?? kind === "road_vehicle";
  const active = optionalBoolean(input.active, "active") ?? true;
  if (input.id) {
    const id = requireId(input.id, "id");
    const updated = await tx.query("update fuel_refund_users set name = $2, kind = $3, road_licensed = $4, is_active = $5, updated_by_email = $6, updated_at = now() where id = $1", [id, name, kind, roadLicensed, active, tx.actor.email]);
    if (!updated.rowCount) throw new NotFoundError("That wasn't found.");
  } else {
    await tx.query("insert into fuel_refund_users (name, kind, road_licensed, updated_by_email) values ($1, $2, $3, $4)", [name, kind, roadLicensed, tx.actor.email]);
  }
  await writeAuditEvent(tx, { eventType: "farming.fuel_user_saved", entityType: "fuel_refund_user", entityId: String(input.id ?? name), details: { name, kind, roadLicensed, active } });
  return users(tx);
}

/** A quarter's tank figures and shares (FUEL5, FUEL6). Blank opening: last quarter's closing. */
export async function saveFuelQuarter(tx: OrgTx, input: { quarterEnd: unknown; opening?: unknown; closing?: unknown; shares?: unknown }): Promise<void> {
  await requireFuelRefund(tx);
  const end = requireQuarter(input.quarterEnd);
  const litres = (value: unknown, label: string) => (value === undefined || value === null || value === "" ? null : parseDecimalInput(value, label, { maxScale: 2, allowZero: true }));
  await tx.query(
    `insert into fuel_refund_quarters (quarter_end, opening_litres, closing_litres, updated_by_email) values ($1, $2, $3, $4)
     on conflict (quarter_end) do update set opening_litres = excluded.opening_litres, closing_litres = excluded.closing_litres, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [end, litres(input.opening, "Tank at the start"), litres(input.closing, "Tank at the end"), tx.actor.email],
  );
  if (input.shares !== undefined) {
    if (!Array.isArray(input.shares)) throw new ValidationError("shares must be a list.");
    const known = new Set((await users(tx)).map((user) => user.id));
    let total = ZERO_DECIMAL;
    const parsed = input.shares.map((raw, index) => {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const userId = requireId(entry.userId, `shares ${index + 1} userId`);
      if (!known.has(userId)) throw new ValidationError(`Share ${index + 1}: that isn't on the list.`);
      const percent = entry.percent === "" || entry.percent === null || entry.percent === undefined ? "0" : parseDecimalInput(entry.percent, "Share", { maxScale: 2, allowZero: true });
      if (cmp(dec(percent), dec("100")) > 0) throw new ValidationError("A share can't be more than 100%.");
      total = add(total, dec(percent));
      return { userId, percent };
    });
    if (cmp(total, dec("100")) > 0) throw new ValidationError(`The shares add up to ${toFixedString(total, 2)}%: they can't be more than 100%.`);
    await tx.query("delete from fuel_refund_shares where quarter_end = $1", [end]);
    for (const share of parsed) {
      await tx.query("insert into fuel_refund_shares (quarter_end, user_id, percent) values ($1, $2, $3)", [end, share.userId, share.percent]);
    }
  }
  await writeAuditEvent(tx, { eventType: "farming.fuel_quarter_saved", entityType: "fuel_refund_quarter", entityId: end, details: {} });
}
