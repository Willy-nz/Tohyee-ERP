import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0026",
    name: "ai_key_end_dates",
    sql: `
-- An AI key can have an end date (#695, decision 1629): the first moment it
-- no longer works. Null means none was set. Keys made before this have none.
-- A key also stops when it hasn't been used for 90 days, worked out from
-- last_used_at (or created_at for one never used), with nothing stored.
alter table ai_access_tokens add column expires_at timestamptz;
`,
  };
