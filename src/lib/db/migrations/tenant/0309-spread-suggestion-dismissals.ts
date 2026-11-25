import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
  version: "0309",
  name: "spread_suggestion_dismissals",
  sql: `
-- Spreading suggestions (SW26-SW28) are worked out from the books each time
-- and never saved. Only a "not this one" is kept, so it doesn't come back.
create table spread_suggestion_dismissals (
  suggestion_key text primary key check (length(suggestion_key) between 3 and 120),
  dismissed_by_email text not null,
  dismissed_at timestamptz not null default now()
);
`,
};
