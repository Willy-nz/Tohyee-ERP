import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";

/*
 * Settings › Business structure (examples ENT1-ENT8, following common
 * practice, not yet reviewed): what kind of entity the organisation is and
 * its IRD number. Words and defaults only: nothing already posted changes.
 */

export {
  ENTITY_OFFICER_ROLE,
  ENTITY_TYPE_LABELS,
  ENTITY_TYPES,
  type EntityType,
  formatIrdNumber,
  incomeTaxTaxpayerFor,
  parseIrdNumber,
} from "@/lib/organisations/entity-types";
import { ENTITY_TYPE_LABELS, ENTITY_TYPES, type EntityType, incomeTaxTaxpayerFor, parseIrdNumber } from "@/lib/organisations/entity-types";

export type BusinessStructure = { entityType: EntityType | null; irdNumber: string | null };

export async function getBusinessStructure(tx: OrgTx): Promise<BusinessStructure> {
  const found = await tx.query<{ entity_type: EntityType | null; ird_number: string | null }>("select entity_type, ird_number from organisation_settings where id = true");
  const row = found.rows[0];
  return { entityType: row?.entity_type ?? null, irdNumber: row?.ird_number ?? null };
}

/** Saves the business structure (ENT1, ENT2); the income tax workpaper's taxpayer follows a company or sole trader (ENT3). */
export async function saveBusinessStructure(tx: OrgTx, input: { entityType: unknown; irdNumber: unknown }): Promise<BusinessStructure> {
  let entityType: EntityType | null = null;
  if (input.entityType !== undefined && input.entityType !== null && input.entityType !== "") {
    if (typeof input.entityType !== "string" || !(ENTITY_TYPES as readonly string[]).includes(input.entityType)) {
      throw new ValidationError(`Choose what kind of entity this is: ${ENTITY_TYPES.map((type) => ENTITY_TYPE_LABELS[type].toLowerCase()).join(", ")}.`);
    }
    entityType = input.entityType as EntityType;
  }
  const irdNumber = parseIrdNumber(input.irdNumber);
  const before = await getBusinessStructure(tx);
  await tx.query("update organisation_settings set entity_type = $1, ird_number = $2, updated_at = now() where id = true", [entityType, irdNumber]);
  if (entityType) {
    const follows = incomeTaxTaxpayerFor(entityType);
    if ("taxpayerType" in follows) {
      await tx.query(
        `update income_tax_settings set taxpayer_type = $1, version = version + 1, updated_by_email = $2, updated_at = now()
          where id and taxpayer_type is distinct from $1`,
        [follows.taxpayerType, tx.actor.email || "Tohyee"],
      );
    }
  }
  await writeAuditEvent(tx, {
    eventType: "organisation.business_structure_saved",
    entityType: "organisation_settings",
    entityId: tx.organisationId,
    details: { from: { entityType: before.entityType, irdNumber: Boolean(before.irdNumber) }, to: { entityType, irdNumber: Boolean(irdNumber) } },
  });
  return { entityType, irdNumber };
}
