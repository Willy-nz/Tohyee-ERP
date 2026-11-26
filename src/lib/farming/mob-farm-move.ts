import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess } from "@/lib/farming/access";
import { animalsIn, animalsOut, checkTaggedFit, requireTaggedIn, taggedIds } from "@/lib/farming/animal-mobs";
import { farmMoveName, farmMoveWarning, naitReminder } from "@/lib/farming/mob-rules";
import { addEvent, eventDate, type Mob, mobRow, openGrazing, optionalOperationId, replayedEvent, requireHead, requirePaddock, setHead } from "@/lib/farming/mobs";
import { requireFarming } from "@/lib/farming/paddocks";
import { requestHash } from "@/lib/idempotency";
import { optionalId, optionalString, requireId } from "@/lib/validation";

/*
 * Moving stock to another farm in the same organisation (OPF7-OPF13, following common practice, not yet
 * reviewed). It's a move, not a sale: the same books, so no livestock movement, no income and no purchase,
 * and the kind and class don't change. All of a mob or some of it goes into a new mob or a mob already on
 * the other farm (the merge rules). Both farms change in one transaction on one date; `operationId` makes
 * a phone's resend find the first. The mob it leaves gets "farm_out" and the mob it joins "farm_in", each
 * naming the other, so the withholding walk (withholding.ts) and the history follow the animals. Tagged
 * animals that go move onto the other farm's register.
 */

const MAX_HEAD = 100000;

export type FarmMoveResult = {
  /** The mob they left (closed when all of it went). */
  from: Mob;
  /** The mob they're in now, on the other farm. */
  to: Mob;
  message: string;
  /** Set when the animals moved are within a withholding period: allowed, and it goes with them. */
  warning: string | null;
  /** For cattle and deer: Tohyee doesn't tell NAIT. */
  nait: string | null;
  /** Never a livestock movement. */
  livestock: "none";
};

type FarmRow = { id: string; name: string; is_active: boolean };

async function farmRow(tx: OrgTx, id: string): Promise<FarmRow> {
  const row = await tx.query<FarmRow>("select id::text, name, is_active from farms where id = $1", [id]);
  if (!row.rows[0]) throw new NotFoundError("Farm not found.");
  return row.rows[0];
}

async function requireToFarm(tx: OrgTx, input: unknown, from: Mob): Promise<FarmRow> {
  const farm = await farmRow(tx, requireId(input, "toFarmId"));
  await requireFarmAccess(tx, farm.id);
  if (farm.id === from.farmId) throw new ValidationError(`${from.name} is already on ${farm.name}. Choose the farm they're going to.`);
  if (!farm.is_active) throw new ValidationError(`${farm.name} is archived. Choose a farm that's in use.`);
  return farm;
}

async function freeName(tx: OrgTx, farmId: string, name: string): Promise<boolean> {
  const taken = await tx.query("select 1 from mobs where farm_id = $1 and status = 'active' and lower(name) = lower($2)", [farmId, name]);
  return !taken.rowCount;
}

/** Tags and EIDs are unique among a farm's animals, so a tag already on the other farm stops the move. */
async function requireTagsFree(tx: OrgTx, animalIds: readonly string[], farm: FarmRow): Promise<void> {
  if (!animalIds.length) return;
  const clash = await tx.query<{ tag: string }>(
    `select a.tag from animals a
       join animals b on b.farm_id = $2 and b.status in ('on_farm', 'missing') and b.id <> a.id
        and ((b.kind = a.kind and lower(b.tag) = lower(a.tag)) or (a.eid is not null and lower(b.eid) = lower(a.eid)))
      where a.id = any($1::bigint[]) order by a.tag limit 1`,
    [animalIds, farm.id],
  );
  if (clash.rows[0]) throw new ConflictError(`${clash.rows[0].tag} is already on ${farm.name}'s register. Change one of the tags first. Nothing was moved.`);
}

export async function moveMobToFarm(tx: OrgTx, mobIdInput: unknown, input: Record<string, unknown>): Promise<FarmMoveResult> {
  await requireFarming(tx);
  const operationId = optionalOperationId(input.operationId);
  const { organisationId: _organisationId, operationId: _operationId, ...rest } = input;
  void _organisationId;
  void _operationId;
  const hash = requestHash("mob_farm_move", { mobId: String(mobIdInput), ...rest });
  if (await replayedEvent(tx, operationId, hash)) {
    const sent = await tx.query<{ mob_id: string; other_mob_id: string }>("select mob_id::text, other_mob_id::text from mob_events where operation_id = $1 and event_type = 'farm_out'", [operationId]);
    if (!sent.rows[0]) throw new ConflictError("This was already sent with different details. Nothing was changed: check it and record it again.");
    const from = await mobRow(tx, sent.rows[0].mob_id);
    return { from, to: await mobRow(tx, sent.rows[0].other_mob_id), message: "Already recorded.", warning: null, nait: naitReminder(from.kind), livestock: "none" };
  }

  const from = await mobRow(tx, mobIdInput, true);
  if (input.farmId !== undefined && input.farmId !== null && input.farmId !== "" && requireId(input.farmId, "farmId") !== from.farmId) {
    throw new ConflictError(`${from.name} isn't on the farm this was recorded for. Nothing was saved: check the farm and try again.`);
  }
  if (from.status !== "active") throw new ValidationError(`${from.name} is closed.`);
  const toFarm = await requireToFarm(tx, input.toFarmId, from);
  const fromFarm = await farmRow(tx, from.farmId);
  const date = eventDate(input.onDate);
  if (from.createdOn && date < from.createdOn) throw new ValidationError(`${from.name} was added on ${from.createdOn}. The date can't be before that.`);
  const head = input.head === undefined || input.head === null || input.head === "" ? from.head : requireHead(input.head);
  if (head > from.head) throw new ValidationError(`${from.name} has ${from.head} head.`);
  const whole = head === from.head;
  const note = optionalString(input.note, "Note", { maxLength: 500 });

  // Tagged animals: all of them with the whole mob; those chosen with part of it (as a split).
  const leaving = whole ? await taggedIds(tx, from.id) : await requireTaggedIn(tx, from, input.animalIds, head);
  if (!whole) await checkTaggedFit(tx, from, from.head - head, leaving.length);
  await requireTagsFree(tx, leaving, toFarm);

  const intoId = optionalId(input.intoMobId, "intoMobId");
  let to: Mob;
  let toPaddockId: string | null = null;
  let grazingId: string | null = null;
  if (intoId) {
    // Into a mob already there: the merge rules.
    to = await mobRow(tx, intoId, true);
    if (to.farmId !== toFarm.id) throw new ValidationError(`${to.name} isn't on ${toFarm.name}. Choose one of ${toFarm.name}'s mobs.`);
    if (to.status !== "active") throw new ValidationError(`${to.name} is closed.`);
    if (to.kind !== from.kind || to.classCode !== from.classCode) {
      throw new ValidationError(`${from.name} is ${from.className.toLowerCase()} and ${to.name} is ${to.className.toLowerCase()}. A mob is one class: change the class first.`);
    }
    if (to.head + head > MAX_HEAD) throw new ValidationError("A mob can have at most 100,000 head.");
    if (to.createdOn && date < to.createdOn) throw new ValidationError(`${to.name} was added on ${to.createdOn}. The date can't be before that.`);
    if (input.toPaddockId) throw new ValidationError(`They join ${to.name} where it is. Leave the paddock out, or move ${to.name} afterwards.`);
  } else {
    const typed = optionalString(input.name, "New mob's name", { maxLength: 100 });
    if (typed && !(await freeName(tx, toFarm.id, typed))) throw new ConflictError(`There's already a mob called ${typed} on ${toFarm.name}.`);
    const suggested = farmMoveName(from.name, fromFarm.name);
    const name = typed ?? ((await freeName(tx, toFarm.id, suggested)) ? suggested : null);
    const paddock = input.toPaddockId ? await requirePaddock(tx, input.toPaddockId, toFarm.id) : null;
    const made = await tx.query<{ id: string }>(
      "insert into mobs (farm_id, name, kind, class_code, head, tag_colour, created_by_email) values ($1, $2, $3, $4, $5, $6, $7) returning id::text",
      [toFarm.id, name, from.kind, from.classCode, head, from.tagColour, tx.actor.email],
    );
    to = await mobRow(tx, made.rows[0].id);
    toPaddockId = paddock?.id ?? null;
    grazingId = paddock ? await openGrazing(tx, to, paddock, date, head) : null;
  }

  const outId = await addEvent(tx, { mobId: from.id, farmId: from.farmId, eventType: "farm_out", eventDate: date, headChange: -head, headAfter: from.head - head, otherMobId: to.id, note, operationId, requestHash: operationId ? hash : null });
  const inId = await addEvent(tx, { mobId: to.id, farmId: to.farmId, eventType: "farm_in", eventDate: date, headChange: head, headAfter: intoId ? to.head + head : head, otherMobId: from.id, toPaddockId, grazingId, note });
  await animalsOut(tx, { animalIds: leaving, mobId: from.id, onDate: date, how: "moved", eventId: outId });
  if (leaving.length) await tx.query("update animals set farm_id = $2 where id = any($1::bigint[])", [leaving, toFarm.id]);
  await animalsIn(tx, { animalIds: leaving, mobId: to.id, onDate: date, how: "moved", eventId: inId });
  if (intoId) await setHead(tx, to, to.head + head, date);
  await setHead(tx, from, from.head - head, date);
  await writeAuditEvent(tx, {
    eventType: "farming.mob_farm_move",
    entityType: "mob",
    entityId: from.id,
    details: { fromFarmId: from.farmId, toFarmId: toFarm.id, toMobId: to.id, head, whole, onDate: date, animalIds: leaving },
  });

  const after = await mobRow(tx, to.id);
  const warning = farmMoveWarning(from.withholding, date, toFarm.name);
  const message = `${head} moved from ${from.name} on ${fromFarm.name} to ${after.name} on ${toFarm.name}. The books' head count doesn't change: it's a move, not a sale.${warning ? ` Warning: ${warning}` : ""}`;
  return { from: await mobRow(tx, from.id), to: after, message, warning, nait: naitReminder(from.kind), livestock: "none" };
}
