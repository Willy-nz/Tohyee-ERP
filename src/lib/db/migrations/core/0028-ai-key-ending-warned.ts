import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0028",
    name: "ai_key_ending_warned",
    sql: `
-- The stop time an AI key's owner has been emailed about (#695, decision
-- 1664), so they're told once: again only if the key's stop time changes
-- (a new end date, or it's used and later goes quiet again).
alter table ai_access_tokens add column ending_warned_for timestamptz;
`,
  };
