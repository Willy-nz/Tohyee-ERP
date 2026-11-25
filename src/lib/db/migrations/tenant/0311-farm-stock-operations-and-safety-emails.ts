import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0311",
    name: "farm_stock_operations_and_safety_emails",
    sql: `
-- A medicine or chemical stock entry, or a move between farms, sent again
-- after a lost reply is found by its operation id instead of being recorded
-- twice (OPF3). A move keeps the id on its moved_out row only.
alter table farm_product_stock add column operation_id uuid;
alter table farm_product_stock add column request_hash text check (request_hash is null or length(request_hash) = 64);
create unique index farm_product_stock_operation on farm_product_stock (operation_id) where operation_id is not null;

-- An email to the organisation's owners and admins when a safety report
-- may need notifying to WorkSafe (OPF6), sent by the email job like other
-- notices. One per report and person. The email gives the report's title,
-- farm and date only, never the restricted injury details.
create table safety_emails (
  id bigserial primary key,
  report_record_id uuid not null,
  to_user_id uuid not null,
  to_email text not null check (length(to_email) between 1 and 320),
  subject text not null check (length(subject) between 1 and 250),
  body text not null check (length(body) between 1 and 5000),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (report_record_id, to_user_id)
);
create index safety_emails_due on safety_emails (next_attempt_at) where status in ('queued', 'sending');
`,
  };
