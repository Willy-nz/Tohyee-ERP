import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess } from "@/lib/farming/access";
import { expiryState, isMedicineKind, MEDICINE_KINDS, type MedicineBadge, type MedicineKind, soonestExpiry, STARTER_LISTS, stockBadge } from "@/lib/farming/medicine-rules";
import { requireFarming } from "@/lib/farming/paddocks";
import { STOCK_UNITS, toBase } from "@/lib/farming/treatment-rules";
import { countedUnit, type ProductUse, productStock, stockAlreadyRecorded, stockOperationId, unitsText } from "@/lib/farming/treatments";
import { requestHash } from "@/lib/idempotency";
import { cmp, dec, parseDecimalInput, toPlainString } from "@/lib/money/decimal";
import { currentRecord, currentRecords, requireSafetyRecorder } from "@/lib/safety/records";
import { addChemical, changeChemical } from "@/lib/safety/register";
import type { ChemicalData } from "@/lib/safety/shared";
import { optionalString, requireId, requireOneOf } from "@/lib/validation";

/*
 * The medicine cabinet (examples MED1-MED10; following common practice, not
 * yet reviewed): a farm's animal medicines from its chemical register, with
 * pictures, stock on hand, reorder levels and expiry, and moving stock between
 * farms. Records only; stock comes from product stock (TRT7-TRT8).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CabinetSlot = {
  chemicalRecordId: string;
  name: string;
  kind: MedicineKind;
  /** The farmer's own photo (MED3); null shows the drawing. */
  photoFileId: string | null;
  onHand: string | null;
  unit: string | null;
  reorderAt: string | null;
  badge: MedicineBadge;
  expiresOn: string | null;
  expiry: "expired" | "soon" | "ok" | null;
  lastCountedOn: string | null;
  location: string | null;
  notCounted: ProductUse[];
  history: ProductUse[];
};

async function farmFor(tx: OrgTx, input: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = requireId(input, "farmId");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  return farmId;
}

/** A farm's cabinet (MED1, MED6, MED7), in kind order then name. */
export async function cabinet(tx: OrgTx, input: { farmId: unknown; today?: string }): Promise<CabinetSlot[]> {
  const farmId = await farmFor(tx, input.farmId);
  const today = input.today ?? todayIsoDate();
  const rows = await tx.query<{ chemical_record_id: string; kind: string; photo_file_id: string | null; reorder_at: string | null }>(
    "select chemical_record_id::text, kind, photo_file_id::text, reorder_at::text from farm_medicines where farm_id = $1",
    [farmId],
  );
  if (!rows.rowCount) return [];
  const entries = new Map(rows.rows.map((row) => [row.chemical_record_id, row]));
  const stock = (await productStock(tx, { farmId })).filter((product) => entries.has(product.chemicalRecordId));
  const chemicals = new Map((await currentRecords<ChemicalData>(tx, "chemical", { farmId })).map((record) => [record.recordId, record]));
  const order = Object.keys(MEDICINE_KINDS);
  return stock
    .map((product) => {
      const entry = entries.get(product.chemicalRecordId)!;
      const kind = isMedicineKind(entry.kind) ? entry.kind : "other";
      const reorderAt = entry.reorder_at === null ? null : toPlainString(dec(entry.reorder_at));
      const oldestFirst = [...product.history].reverse();
      const expiresOn = soonestExpiry(oldestFirst, product.onHand);
      return {
        chemicalRecordId: product.chemicalRecordId,
        name: product.name,
        kind,
        photoFileId: entry.photo_file_id,
        onHand: product.onHand,
        unit: product.unit,
        reorderAt,
        badge: stockBadge(product.onHand, reorderAt),
        expiresOn,
        expiry: expiryState(expiresOn, today),
        lastCountedOn: product.lastCountedOn,
        location: chemicals.get(product.chemicalRecordId)?.data.location ?? null,
        notCounted: product.notCounted,
        history: product.history,
      };
    })
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
}

async function farmChemical(tx: OrgTx, input: unknown) {
  if (typeof input !== "string" || !UUID.test(input)) throw new ValidationError("Choose a product.");
  const chemical = await currentRecord<ChemicalData>(tx, "chemical", input);
  if (!chemical.farmId) throw new ValidationError("That product isn't kept on a farm.");
  await farmFor(tx, chemical.farmId);
  return chemical;
}

async function putInCabinet(tx: OrgTx, chemicalRecordId: string, farmId: string, kind: MedicineKind) {
  await tx.query(
    `insert into farm_medicines (chemical_record_id, farm_id, kind, updated_by_email) values ($1, $2, $3, $4)
     on conflict (chemical_record_id) do update set kind = excluded.kind, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [chemicalRecordId, farmId, kind, tx.actor.email],
  );
}

/**
 * Adds a product to a farm's cabinet (MED1, MED2): one already in its
 * chemical register (`chemicalRecordId`), or a new one (`name`, and `unit`
 * from the kind when not given).
 */
export async function addMedicine(tx: OrgTx, input: Record<string, unknown>): Promise<CabinetSlot[]> {
  requireSafetyRecorder(tx);
  const kind = requireOneOf(input.kind, "Kind", Object.keys(MEDICINE_KINDS) as MedicineKind[]);
  let chemicalRecordId: string;
  let farmId: string;
  if (input.chemicalRecordId) {
    const chemical = await farmChemical(tx, input.chemicalRecordId);
    if (chemical.data.removed) throw new ValidationError("That product has been removed from the chemical register.");
    chemicalRecordId = chemical.recordId;
    farmId = chemical.farmId!;
  } else {
    farmId = await farmFor(tx, input.farmId);
    const unit = input.unit ? requireOneOf(input.unit, "Unit", STOCK_UNITS) : MEDICINE_KINDS[kind].unit;
    // Two products of one name on a farm can't be told apart (a move picks one by name), so a second is refused.
    const name = typeof input.name === "string" ? input.name.trim().toLowerCase() : "";
    const sameName = (await currentRecords<ChemicalData>(tx, "chemical", { farmId })).find((record) => record.farmId === farmId && !record.data.removed && record.data.name.trim().toLowerCase() === name);
    // A resend of the add that made it (same operation id) isn't a second one.
    const replay = typeof input.operationId === "string" && input.operationId !== "" && Boolean((await tx.query("select 1 from safety_entries where operation_id = $1", [input.operationId])).rowCount);
    if (sameName && !replay) throw new ValidationError(`${sameName.data.name} is already in this farm's chemical register. Pick it from the list instead.`);
    const created = await addChemical(tx, { farmId, name: input.name, unit, location: input.location, operationId: input.operationId });
    chemicalRecordId = created.recordId;
  }
  await putInCabinet(tx, chemicalRecordId, farmId, kind);
  await writeAuditEvent(tx, { eventType: "farming.medicine_added", entityType: "chemical", entityId: chemicalRecordId, details: { kind } });
  return cabinet(tx, { farmId });
}

/** Adds the common kinds for a dairy or sheep farm that the farmer kept ticked, skipping kinds the cabinet has (MED2). */
export async function addStarterList(tx: OrgTx, input: { farmId: unknown; list: unknown; kinds?: unknown }): Promise<CabinetSlot[]> {
  requireSafetyRecorder(tx);
  const farmId = await farmFor(tx, input.farmId);
  const list = requireOneOf(input.list, "List", Object.keys(STARTER_LISTS) as Array<keyof typeof STARTER_LISTS>);
  const offered: readonly MedicineKind[] = STARTER_LISTS[list];
  let kinds: MedicineKind[] = [...offered];
  if (input.kinds !== undefined) {
    if (!Array.isArray(input.kinds)) throw new ValidationError("kinds must be a list.");
    kinds = input.kinds.map((value) => {
      if (!isMedicineKind(value) || !offered.includes(value)) throw new ValidationError(`${String(value)} isn't on the ${list} list.`);
      return value;
    });
  }
  const have = new Set((await tx.query<{ kind: string }>("select kind from farm_medicines where farm_id = $1", [farmId])).rows.map((row) => row.kind));
  let added = 0;
  for (const kind of kinds) {
    if (have.has(kind)) continue;
    have.add(kind);
    const info = MEDICINE_KINDS[kind];
    const created = await addChemical(tx, { farmId, name: info.label, unit: info.unit });
    await putInCabinet(tx, created.recordId, farmId, kind);
    added += 1;
  }
  await writeAuditEvent(tx, { eventType: "farming.medicine_starter_list", entityType: "farm", entityId: farmId, details: { list, added } });
  return cabinet(tx, { farmId });
}

/** Changes a cabinet product's name, kind, photo or reorder level (MED2, MED3, MED6). */
export async function updateMedicine(tx: OrgTx, input: Record<string, unknown>): Promise<CabinetSlot[]> {
  requireSafetyRecorder(tx);
  const chemical = await farmChemical(tx, input.chemicalRecordId);
  const farmId = chemical.farmId!;
  const entry = (await tx.query<{ kind: string }>("select kind from farm_medicines where chemical_record_id = $1", [chemical.recordId])).rows[0];
  if (!entry) throw new NotFoundError("That product isn't in the cabinet.");
  if (input.kind !== undefined) {
    const kind = requireOneOf(input.kind, "Kind", Object.keys(MEDICINE_KINDS) as MedicineKind[]);
    await tx.query("update farm_medicines set kind = $2 where chemical_record_id = $1", [chemical.recordId, kind]);
  }
  if (input.reorderAt !== undefined) {
    const reorderAt = input.reorderAt === null || input.reorderAt === "" ? null : parseDecimalInput(input.reorderAt, "Reorder level", { maxScale: 3, allowZero: true });
    await tx.query("update farm_medicines set reorder_at = $2 where chemical_record_id = $1", [chemical.recordId, reorderAt]);
  }
  if (input.photoFileId !== undefined) {
    let photo: string | null = null;
    if (input.photoFileId !== null && input.photoFileId !== "") {
      if (typeof input.photoFileId !== "string" || !UUID.test(input.photoFileId)) throw new ValidationError("Choose a photo.");
      const file = await tx.query<{ content_type: string; farm_id: string | null; restricted: boolean }>("select content_type, farm_id::text, restricted from safety_files where id = $1", [input.photoFileId]);
      const row = file.rows[0];
      if (!row || row.farm_id !== farmId || row.restricted || !row.content_type.startsWith("image/")) throw new ValidationError("Use a photo taken for this farm.");
      photo = input.photoFileId;
    }
    await tx.query("update farm_medicines set photo_file_id = $2 where chemical_record_id = $1", [chemical.recordId, photo]);
  }
  if (input.name !== undefined && input.name !== chemical.data.name) {
    await changeChemical(tx, chemical.recordId, { name: input.name, expectedVersion: chemical.version });
  }
  await tx.query("update farm_medicines set updated_by_email = $2, updated_at = now() where chemical_record_id = $1", [chemical.recordId, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.medicine_changed", entityType: "chemical", entityId: chemical.recordId, details: { changed: Object.keys(input).filter((key) => ["kind", "reorderAt", "photoFileId", "name"].includes(key)) } });
  return cabinet(tx, { farmId });
}

/** Takes a product out of the cabinet: its stock history, treatments and register entry stay (MED9). */
export async function removeMedicine(tx: OrgTx, input: { chemicalRecordId: unknown }): Promise<CabinetSlot[]> {
  requireSafetyRecorder(tx);
  const chemical = await farmChemical(tx, input.chemicalRecordId);
  const removed = await tx.query("delete from farm_medicines where chemical_record_id = $1", [chemical.recordId]);
  if (!removed.rowCount) throw new NotFoundError("That product isn't in the cabinet.");
  await writeAuditEvent(tx, { eventType: "farming.medicine_removed", entityType: "chemical", entityId: chemical.recordId, details: {} });
  return cabinet(tx, { farmId: chemical.farmId });
}

/**
 * Moves stock to another farm (MED5): off this product, onto the other farm's
 * product with the same name (added to its register and cabinet if it has
 * none). Not more than is on hand.
 */
export async function moveMedicine(tx: OrgTx, input: Record<string, unknown>): Promise<CabinetSlot[]> {
  const chemical = await farmChemical(tx, input.chemicalRecordId);
  const fromFarmId = chemical.farmId!;
  const toFarmId = await farmFor(tx, input.toFarmId);
  if (toFarmId === fromFarmId) throw new ValidationError("Choose a different farm to move it to.");
  const movedOn = input.movedOn ? parseIsoDate(input.movedOn, "Date") : todayIsoDate();
  const quantity = parseDecimalInput(input.quantity, "Quantity", { maxScale: 3 });
  const unit = requireOneOf(input.unit, "Unit", STOCK_UNITS);
  const note = optionalString(input.note, "Note", { maxLength: 200 });
  const operationId = stockOperationId(input.operationId);
  const hash = requestHash("medicine_move", { chemicalRecordId: chemical.recordId, toFarmId, movedOn, quantity, unit, note });
  if (await stockAlreadyRecorded(tx, operationId, hash)) return cabinet(tx, { farmId: fromFarmId });
  const slots = await cabinet(tx, { farmId: fromFarmId });
  const slot = slots.find((entry) => entry.chemicalRecordId === chemical.recordId);
  const base = toBase(quantity, unit);
  if (!slot || slot.onHand === null || !base || base.unit !== slot.unit) {
    throw new ValidationError(slot?.onHand === null || !slot ? "Record a count of it on this farm first." : `Move it in ${slot.unit}, the unit it's counted in.`);
  }
  if (cmp(dec(base.quantity), dec(slot.onHand)) > 0) throw new ValidationError(`Only ${slot.onHand} ${slot.unit} is on hand.`);
  // The other farm's product of the same name, or a new one with the same kind and unit.
  const theirs = (await currentRecords<ChemicalData>(tx, "chemical", { farmId: toFarmId })).find((record) => record.farmId === toFarmId && !record.data.removed && record.data.name.trim().toLowerCase() === chemical.data.name.trim().toLowerCase());
  let toRecordId: string;
  if (theirs) {
    toRecordId = theirs.recordId;
    // It's added to their count, so it must be in the unit theirs is counted in (OPF2).
    const theirUnit = await countedUnit(tx, toRecordId);
    if (theirUnit !== null && theirUnit !== slot.unit) {
      throw new ValidationError(`${theirs.data.name} on the other farm is counted in ${theirUnit}, and this is counted in ${slot.unit}, so it can't be added to it. Count both in ${unitsText(theirUnit)} first, or rename one of them.`);
    }
    const inCabinet = await tx.query("select 1 from farm_medicines where chemical_record_id = $1", [toRecordId]);
    if (!inCabinet.rowCount) await putInCabinet(tx, toRecordId, toFarmId, slot.kind);
  } else {
    requireSafetyRecorder(tx);
    const created = await addChemical(tx, { farmId: toFarmId, name: chemical.data.name, unit: slot.unit, hazards: chemical.data.hazards, storage: chemical.data.storage });
    toRecordId = created.recordId;
    await putInCabinet(tx, toRecordId, toFarmId, slot.kind);
  }
  const expiresOn = slot.expiresOn;
  const insert =
    "insert into farm_product_stock (chemical_record_id, farm_id, movement_type, moved_on, quantity, unit, expires_on, note, created_by_email, moved_farm_id, operation_id, request_hash) values ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10, $11, $12)";
  // The operation id goes on the moved_out row only, so a resend finds the move once.
  await tx.query(insert, [chemical.recordId, fromFarmId, "moved_out", movedOn, quantity, unit, null, note, tx.actor.email, toFarmId, operationId, operationId ? hash : null]);
  await tx.query(insert, [toRecordId, toFarmId, "moved_in", movedOn, quantity, unit, expiresOn, note, tx.actor.email, fromFarmId, null, null]);
  await writeAuditEvent(tx, { eventType: "farming.medicine_moved", entityType: "chemical", entityId: chemical.recordId, details: { toFarmId, toRecordId, quantity, unit, movedOn } });
  return slots.length ? cabinet(tx, { farmId: fromFarmId }) : [];
}
