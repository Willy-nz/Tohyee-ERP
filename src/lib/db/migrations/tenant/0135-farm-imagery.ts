import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0135",
    name: "farm_imagery",
    sql: `
-- The organisation's own LINZ Basemaps API key, for aerial imagery behind the
-- paddock map (#249). Not a secret: browsers load the tiles with it.
alter table farming_settings add column linz_basemaps_key text check (linz_basemaps_key ~ '^[A-Za-z0-9_-]{8,128}$');
`,
  };
