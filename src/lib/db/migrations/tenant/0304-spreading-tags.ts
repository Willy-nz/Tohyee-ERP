import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0304",
    name: "spreading_tags",
    sql: `
-- A Spreading item's tracking and line custom fields (SW25) go on the income
-- or expense line of each month's journal. Tracking was already kept for
-- items made from a bill, invoice or bank line; now any item can have it,
-- checked the way a document line's is.
alter table spread_items add column custom_fields jsonb not null default '{}'::jsonb;
create trigger spread_items_tracking before insert or update on spread_items
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
`,
  };
