import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0297",
    name: "trust_return",
    sql: `
-- The rest of a trust's return (examples TRT15-TRT27). Nothing here posts to
-- the ledger.
-- Complying, foreign or non-complying (TRT20).
alter table income_tax_settings add column trust_class text not null default 'complying' check (trust_class in ('complying', 'foreign', 'non_complying'));

-- What the IR6B asks for about a beneficiary (TRT25): an IRD number, or for
-- someone taxed overseas, where and their tax number there.
alter table trust_beneficiaries add column ird_number text check (ird_number ~ '^[0-9]{9}$');
alter table trust_beneficiaries add column jurisdiction text check (length(btrim(jurisdiction)) between 1 and 100);
alter table trust_beneficiaries add column tin text check (length(btrim(tin)) between 1 and 50);

-- A beneficiary's year: beneficiary income can be nil when only a
-- distribution was made (TRT18, TRT21, TRT24).
alter table trust_beneficiary_income drop constraint trust_beneficiary_income_amount_check;
alter table trust_beneficiary_income add constraint trust_beneficiary_income_amount_check check (amount >= 0);
alter table trust_beneficiary_income add column trustee_pays_tax boolean not null default false;
alter table trust_beneficiary_income add column other_income numeric(18, 2) not null default 0 check (other_income >= 0);
alter table trust_beneficiary_income add column taxable_distribution numeric(18, 2) not null default 0 check (taxable_distribution >= 0);
alter table trust_beneficiary_income add column non_taxable_distribution numeric(18, 2) not null default 0 check (non_taxable_distribution >= 0);
alter table trust_beneficiary_income add column withdrawn numeric(18, 2) not null default 0;
-- Null: last year's closing balance (TRT24).
alter table trust_beneficiary_income add column opening_balance numeric(18, 2);
`,
};
