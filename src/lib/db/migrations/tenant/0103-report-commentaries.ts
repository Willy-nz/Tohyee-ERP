import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0103",
    name: "report_commentaries",
    sql: `
-- AI commentary as a suggestion (item 6 part 3, decision 446): a commentary
-- on the cash flow forecast, written by a person or suggested by the
-- connected AI, shown as not checked until a person accepts or edits it.
create table report_commentaries (
  id bigserial primary key,
  report text not null check (report in ('cash_flow_forecast')),
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
