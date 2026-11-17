import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0137",
    name: "roster_emails",
    sql: `
-- Telling staff their shifts when a roster is published (RS4): one email
-- per employee per publish, sent by the email job like approval emails.
-- Plain text: the employee's own shifts, never pay figures.
create table roster_emails (
  id bigserial primary key,
  roster_id bigint not null references payroll_rosters(id),
  published_at timestamptz not null,
  employee_id uuid not null references payroll_employees(id),
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
  unique (roster_id, published_at, employee_id)
);
create index roster_emails_due on roster_emails (next_attempt_at) where status in ('queued', 'sending');
`,
  };
