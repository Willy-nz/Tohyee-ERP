import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0251",
    name: "access_emails",
    sql: `
-- Reminders that a member's time-limited access ends soon (decision 1471):
-- emailed 3 days before, to the member and to the owners and admins, through
-- the organisation's own email (Settings > Email), by the email job like
-- other notices. One per person for each end time, so changing the end
-- (Extend) brings a new reminder before the new end.
create table access_emails (
  id bigserial primary key,
  member_user_id uuid not null,
  access_ends_at timestamptz not null,
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
  unique (member_user_id, access_ends_at, to_email)
);
create index access_emails_due on access_emails (next_attempt_at) where status in ('queued', 'sending');
`,
  };
