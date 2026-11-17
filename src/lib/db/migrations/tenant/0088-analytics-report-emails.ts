import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0088",
    name: "analytics_report_emails",
    sql: `
create table analytics_report_mailboxes (
  id bigserial primary key,
  kind text not null check (kind in ('crm', 'imap')),
  account_id bigint references crm_connected_accounts(id) on delete cascade,
  owner_user_id uuid not null,
  host text,
  port integer,
  username text,
  password_ciphertext text,
  folder_id text not null check (length(folder_id) between 1 and 500),
  folder_name text not null check (length(folder_name) between 1 and 500),
  replace_files boolean not null default true,
  lease_id uuid,
  lease_until timestamptz,
  last_check_at timestamptz,
  created_by_email text not null,
  updated_at timestamptz not null default now(),
  check ((kind = 'crm' and account_id is not null and host is null and port is null and username is null and password_ciphertext is null)
      or (kind = 'imap' and account_id is null and host is not null and port = 993 and username is not null and password_ciphertext is not null))
);
create table analytics_report_email_checks (
  id bigserial primary key,
  mailbox_id bigint not null references analytics_report_mailboxes(id) on delete cascade,
  trigger text not null check (trigger in ('manual', 'schedule')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  files_saved integer not null default 0 check (files_saved >= 0),
  error text,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  requested_by_email text not null,
  files jsonb not null default '[]'::jsonb
);
create index analytics_report_email_checks_mailbox_idx on analytics_report_email_checks (mailbox_id, started_at desc);
-- Messages already dealt with: saved, or failed. A failed message is tried
-- again on later checks, up to three times, then left with its reason.
create table analytics_report_email_messages (
  mailbox_id bigint not null references analytics_report_mailboxes(id) on delete cascade,
  message_id text not null,
  received_at timestamptz,
  saved_at timestamptz not null default now(),
  status text not null default 'saved' check (status in ('saved', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 3),
  error text,
  primary key (mailbox_id, message_id)
);
-- Reserve the newest receipt before filesystem writes. Retrying that same
-- message can finish a crashed write, but an older receipt cannot replace it.
create table analytics_report_email_outputs (
  mailbox_id bigint not null references analytics_report_mailboxes(id) on delete cascade,
  output_name text not null,
  received_at timestamptz not null,
  message_id text not null,
  primary key (mailbox_id, output_name)
);
`,
  };
