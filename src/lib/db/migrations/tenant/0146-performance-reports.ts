import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0146",
    name: "performance_reports",
    sql: `
-- Tier 3 and Tier 4 not-for-profit performance reports (examples
-- NPR1-NPR10, decision 536). Nothing here posts.
-- The report format and the entity information printed at the front.
create table performance_report_settings (
  id integer primary key check (id = 1),
  format text not null default 'special_purpose' check (format in ('special_purpose', 'tier3', 'tier4')),
  entity jsonb not null default '{}'::jsonb,
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

-- Each account's XRB category, when someone has chosen one (otherwise
-- Tohyee suggests one from the account type), and for balance sheet
-- accounts the operating category their cash goes to.
create table performance_report_categories (
  account_id bigint primary key references accounts(id),
  category text not null check (length(category) between 1 and 40),
  cash_category text check (cash_category is null or length(cash_category) between 1 and 40),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

-- The statement of service performance for each year: key activities and
-- their measures, this year and last.
create table service_performance (
  year_end date primary key,
  activities jsonb not null,
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
`,
  };
