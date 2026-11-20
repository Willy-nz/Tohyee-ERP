import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0296",
    name: "trust_tax",
    sql: `
-- Income tax for trusts (examples TRT1-TRT14). Nothing here posts to the
-- ledger.
alter table income_tax_settings drop constraint income_tax_settings_taxpayer_type_check;
alter table income_tax_settings add constraint income_tax_settings_taxpayer_type_check check (taxpayer_type in ('company', 'individual', 'trust'));
-- What kind of trust (TRT1, TRT5, TRT6); an estate keeps its date of death.
alter table income_tax_settings add column trust_kind text not null default 'family' check (trust_kind in ('family', 'deceased_estate', 'disabled_beneficiary'));
alter table income_tax_settings add column date_of_death date;
alter table income_tax_settings add constraint income_tax_settings_death_check check (trust_kind = 'deceased_estate' or date_of_death is null);

-- The trust's beneficiaries (TRT2).
create table trust_beneficiaries (
  id bigserial primary key,
  name text not null check (length(btrim(name)) between 1 and 200),
  kind text not null check (kind in ('person', 'company')),
  date_of_birth date,
  settled_by_relative boolean not null default true,
  disability_allowance boolean not null default false,
  corporate_rule boolean not null default true,
  check (kind = 'person' or (date_of_birth is null and not disability_allowance)),
  archived_at timestamptz,
  updated_by_email text,
  updated_at timestamptz not null default now()
);

-- Beneficiary income for an income year, typed by the preparer (TRT3).
create table trust_beneficiary_income (
  income_year integer not null check (income_year between 2000 and 2100),
  beneficiary_id bigint not null references trust_beneficiaries(id),
  amount numeric(18, 2) not null check (amount > 0),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  primary key (income_year, beneficiary_id)
);
`,
};
