import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0008",
    name: "consolidation_commentaries",
    sql: `
-- AI commentary on consolidated reports (decision 446), as on the cash flow
-- forecast, kept with the group.
create table consolidation_commentaries (
  id bigserial primary key,
  group_id bigint not null references consolidation_groups(id),
  report text not null check (report in ('consolidated_profit_and_loss', 'consolidated_balance_sheet')),
  period_label text not null check (length(period_label) between 1 and 200),
  body text not null check (length(body) between 1 and 5000),
  status text not null check (status in ('suggested', 'accepted')),
  -- The person whose AI key wrote it, and the key ('AI key "Claude"'); null via for one a person wrote.
  written_by_email text not null,
  written_via text,
  accepted_by_email text,
  accepted_at timestamptz,
  removed_by_email text,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((removed_at is null) = (removed_by_email is null))
);
`,
  };
