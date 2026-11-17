import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0156",
    name: "income_tax_imputation_and_overseas_credits",
    sql: `
-- Imputation credits received and overseas tax paid, typed apart from the
-- refundable tax credits (examples ITX58-ITX61, decision 555).
alter table income_tax_years add column imputation_credits numeric(18, 2) not null default 0 check (imputation_credits >= 0);
alter table income_tax_years add column overseas_tax_paid numeric(18, 2) not null default 0 check (overseas_tax_paid >= 0);
`,
  };
