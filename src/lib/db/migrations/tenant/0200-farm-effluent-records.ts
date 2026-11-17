import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0200",
    name: "farm_effluent_records",
    sql: `
-- Farm dairy effluent records (#487, decisions 1070-1099, docs/FARM-EFFLUENT.md)
-- are kept in the same append-only, hash-chained history as farm safety
-- (migration 0189): every version dated by the database, nothing changed or
-- deleted, a correction is a new version that says why. So effluent records
-- get the same history check, photos (with the camera's time and the
-- phone's place) and weekly copy as safety. Only the kinds are new.
alter table safety_entries drop constraint safety_entries_kind_check;
alter table safety_entries add constraint safety_entries_kind_check check (kind in (
  'hazard', 'emergency_info', 'report', 'report_details', 'action',
  'induction', 'induction_signoff', 'visit',
  'equipment', 'checklist', 'check', 'equipment_release',
  'training', 'chemical',
  'effluent_system', 'effluent_pond', 'effluent_block', 'effluent_zone', 'effluent_consent',
  'effluent_application', 'effluent_pond_reading', 'effluent_deferral',
  'effluent_service', 'effluent_incident'));
`,
  };
