import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0176",
    name: "analytics_report_themes",
    sql: `
-- An organisation's own report themes (#376, decision 668): colours for
-- light and dark, a font from a safe list, text sizes and the card style,
-- checked by parseReportTheme before they're stored. A report chooses one
-- in its settings ("custom:<id>"); the Tohyee theme stays the default.
create table analytics_themes (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 60 and name = btrim(name)),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
create unique index analytics_themes_name on analytics_themes (lower(name));
`,
  };
