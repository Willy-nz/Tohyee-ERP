import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
  version: "0315",
  name: "tax_decisions",
  sql: `
-- Unpaid leave of more than a week moves the anniversary only by the part
-- over one week (TXF10). Leave already recorded keeps the earlier whole-period
-- move until a person switches it (TXF11); new leave uses the current rule.
alter table payroll_unpaid_leave add column anniversary_rule text not null default 'whole_period'
  check (anniversary_rule in ('whole_period', 'over_one_week'));
alter table payroll_unpaid_leave alter column anniversary_rule set default 'over_one_week';
alter table payroll_unpaid_leave add column anniversary_rule_changed_at timestamptz;
alter table payroll_unpaid_leave add column anniversary_rule_changed_by_email text;

-- Lines trusts (33%) and legacy superannuation funds (28%) (TXF12, TXF13).
alter table income_tax_settings drop constraint income_tax_settings_trust_kind_check;
alter table income_tax_settings add constraint income_tax_settings_trust_kind_check
  check (trust_kind in ('family', 'deceased_estate', 'disabled_beneficiary', 'lines_trust', 'legacy_superannuation'));

-- The provisional tax option for each income year (TXF14-TXF17). No row: standard.
create table income_tax_provisional_options (
  income_year integer primary key check (income_year between 2000 and 2100),
  provisional_option text not null check (provisional_option in ('standard', 'estimation', 'ratio', 'aim')),
  -- The GST ratio IRD gave, as a percentage (ratio option only).
  ratio_percent numeric(9, 4) check (ratio_percent is null or (ratio_percent > 0 and ratio_percent < 100)),
  check ((provisional_option = 'ratio') = (ratio_percent is not null)),
  version integer not null default 1,
  updated_by_email text,
  updated_at timestamptz not null default now()
);

-- Estimates of residual income tax under the estimation option (TXF15), each
-- from the date it was made; a later one replaces an earlier one from its date.
create table income_tax_provisional_estimates (
  id bigserial primary key,
  idempotency_key text not null unique,
  request_hash text not null,
  income_year integer not null check (income_year between 2000 and 2100),
  estimated_on date not null,
  amount numeric(18, 2) not null check (amount >= 0),
  note text,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index income_tax_provisional_estimates_year on income_tax_provisional_estimates (income_year, estimated_on);
`,
};
