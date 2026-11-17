import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0134",
    name: "fertiliser_planner",
    sql: `
-- Fertiliser plans, purchases and applications (examples FB1-FB8, approved
-- by Jess 13 Oct 2026; decision 514). Fertiliser is expensed when bought:
-- a purchase is a link to an approved bill line, and an application is a
-- record on a paddock. Neither posts; the bills already did. Links to bill
-- lines have no foreign key (as elsewhere, so their truncate guards stand);
-- they're checked when made, and voided bills are left out when reading.
alter table farming_settings
  add column fertiliser_account_id bigint references accounts(id),
  add column spreading_account_id bigint references accounts(id);

create table fertiliser_products (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  n_pct numeric not null default 0 check (n_pct between 0 and 100 and scale(n_pct) <= 2),
  p_pct numeric not null default 0 check (p_pct between 0 and 100 and scale(p_pct) <= 2),
  k_pct numeric not null default 0 check (k_pct between 0 and 100 and scale(k_pct) <= 2),
  s_pct numeric not null default 0 check (s_pct between 0 and 100 and scale(s_pct) <= 2),
  is_active boolean not null default true,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check (n_pct + p_pct + k_pct + s_pct <= 100)
);
create unique index fertiliser_products_name on fertiliser_products (lower(name));

create table fertiliser_plans (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  name text not null check (length(name) between 1 and 100),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create unique index fertiliser_plans_name on fertiliser_plans (farm_id, lower(name));

-- Each version is kept (FB2); the newest is the plan.
create table fertiliser_plan_versions (
  id bigserial primary key,
  plan_id bigint not null references fertiliser_plans(id),
  version integer not null check (version > 0),
  spreading_per_ha numeric check (spreading_per_ha is null or (spreading_per_ha >= 0 and scale(spreading_per_ha) <= 2)),
  note text check (note is null or length(note) <= 500),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (plan_id, version)
);

create table fertiliser_plan_lines (
  id bigserial primary key,
  version_id bigint not null references fertiliser_plan_versions(id),
  paddock_id bigint not null references paddocks(id),
  product_id bigint not null references fertiliser_products(id),
  rate_kg_ha numeric not null check (rate_kg_ha > 0 and scale(rate_kg_ha) <= 2),
  treated_ha numeric not null check (treated_ha > 0 and scale(treated_ha) <= 2),
  price_per_tonne numeric check (price_per_tonne is null or (price_per_tonne >= 0 and scale(price_per_tonne) <= 2)),
  unique (version_id, paddock_id, product_id)
);

-- Product bought for a plan (FB3): an approved bill line and how many tonnes it was.
create table fertiliser_purchases (
  id bigserial primary key,
  plan_id bigint not null references fertiliser_plans(id),
  product_id bigint not null references fertiliser_products(id),
  bill_line_id bigint not null unique,
  tonnes numeric not null check (tonnes > 0 and scale(tonnes) <= 3),
  created_by_email text not null,
  created_at timestamptz not null default now()
);

-- What was applied where (FB4). Posts nothing.
create table fertiliser_applications (
  id bigserial primary key,
  plan_id bigint not null references fertiliser_plans(id),
  paddock_id bigint not null references paddocks(id),
  product_id bigint not null references fertiliser_products(id),
  applied_on date not null,
  tonnes numeric not null check (tonnes > 0 and scale(tonnes) <= 3),
  treated_ha numeric not null check (treated_ha > 0 and scale(treated_ha) <= 2),
  source text not null check (length(source) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index fertiliser_applications_plan on fertiliser_applications (plan_id) where status = 'active';

-- A spreading bill line and the applications it covered (FB5), shared by hectares for reports.
create table fertiliser_spreading (
  bill_line_id bigint not null,
  application_id bigint not null references fertiliser_applications(id),
  primary key (bill_line_id, application_id)
);

alter table farm_imports drop constraint farm_imports_kind_check;
alter table farm_imports add constraint farm_imports_kind_check check (kind in ('paddock_boundaries', 'fertiliser_applications'));
`,
  };
