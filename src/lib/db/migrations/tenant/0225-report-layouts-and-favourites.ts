import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0225",
    name: "report_layouts_and_favourites",
    sql: `
-- Reports edited like Xero's (decisions 1359-1362). Each standard financial
-- report can have one default layout: a draft custom report (named
-- versions are other drafts), which Reports shows instead of the standard
-- rows until it's cleared. Favourites are each person's starred reports in
-- the picker. Nothing here touches the ledger.
create table report_layout_defaults (
  base text primary key check (base in ('profit_and_loss', 'balance_sheet')),
  custom_report_id bigint not null unique references custom_reports(id),
  set_by_email text,
  set_at timestamptz not null default now()
);

create table report_favourites (
  user_id uuid not null,
  -- "std:pnl" for a standard report, "custom:42" for a custom one.
  report_key text not null check (report_key ~ '^(std:[a-z]{2,20}|custom:[1-9][0-9]{0,17})$'),
  created_at timestamptz not null default now(),
  primary key (user_id, report_key)
);
`,
  };
