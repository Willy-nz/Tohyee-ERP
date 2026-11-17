import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0236",
    name: "farm_terms_grazing_import",
    sql: `
-- Farm words (decision 1448): an organisation's own names for mobs, mob
-- actions, kinds and classes, for screens only. IRD's classes stay as they
-- are underneath. And grazing history imports (decision 1447).
create table farm_terms (
  term_key text primary key check (term_key ~ '^[a-z_]+(:[a-z0-9_.]+)?$' and length(term_key) <= 80),
  label text not null check (length(label) between 1 and 60),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

alter table farm_imports drop constraint farm_imports_kind_check;
alter table farm_imports add constraint farm_imports_kind_check check (kind in ('paddock_boundaries', 'fertiliser_applications', 'soil_tests', 'pasture_readings', 'mobs', 'grazings'));
`,
  };
