import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0157",
    name: "income_tax_imputation_brought_forward",
    sql: `
-- An individual's excess imputation credits brought forward, from IRD's
-- letter (IR3 box 34; example ITX65, decision 556).
alter table income_tax_years add column imputation_brought_forward numeric(18, 2) not null default 0 check (imputation_brought_forward >= 0);
`,
  };
