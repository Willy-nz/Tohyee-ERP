import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0199",
    name: "farm_imagery_key_saved_at",
    sql: `
-- When the LINZ Basemaps key was saved (#485, decision 1061), so Tohyee can
-- remind an admin before a standard key's 90 days run out. Keys saved
-- before this take the time of their last "key set" audit event.
alter table farming_settings add column linz_basemaps_key_saved_at timestamptz;
update farming_settings set linz_basemaps_key_saved_at = coalesce(
  (select max(created_at) from audit_events where event_type = 'farming.imagery_key_set'),
  updated_at,
  now()
) where linz_basemaps_key is not null;
alter table farming_settings add constraint farming_settings_key_saved_at check ((linz_basemaps_key is null) = (linz_basemaps_key_saved_at is null));
`,
  };
