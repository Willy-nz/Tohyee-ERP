import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0116",
    name: "crm_lead_intake",
    sql: `
-- Leads from a web form and from email (decision 493, #216). A form has a
-- random key in its address; what it sends becomes an unassigned lead to
-- review. A trap field only robots fill in, and a limit per address, keep
-- spam down (Jess 10 Oct 2026: no outside service).
create table crm_lead_forms (
  id bigserial primary key,
  name text not null unique check (length(name) between 1 and 100),
  form_key text not null unique check (form_key ~ '^[0-9a-f]{40}$'),
  is_active boolean not null default true,
  thank_you_url text check (thank_you_url is null or (length(thank_you_url) <= 500 and thank_you_url ~ '^https?://')),
  leads_received integer not null default 0 check (leads_received >= 0),
  last_lead_at timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A mailbox folder or label whose emails become leads, read as the admin who
-- set it up (their own CRM mailbox, or IMAP), like the bills inbox (BI2).
create table crm_lead_mailboxes (
  id bigserial primary key,
  mail_kind text not null check (mail_kind in ('crm', 'imap')),
  mail_account_id bigint references crm_connected_accounts(id) on delete set null,
  imap_host text check (imap_host is null or length(imap_host) between 1 and 253),
  imap_username text check (imap_username is null or length(imap_username) between 1 and 320),
  imap_password_ciphertext text,
  mail_folder_id text not null check (length(mail_folder_id) between 1 and 500),
  mail_folder_name text not null check (length(mail_folder_name) between 1 and 500),
  owner_user_id uuid not null,
  sync_every_hours integer not null default 1 check (sync_every_hours between 1 and 24),
  last_check_at timestamptz,
  last_status text check (last_status in ('ok', 'failed')),
  last_error text check (last_error is null or length(last_error) <= 1000),
  last_leads_added integer check (last_leads_added >= 0),
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mail_kind <> 'imap' or (imap_host is not null and imap_username is not null and imap_password_ciphertext is not null))
);

-- Emails already made into leads: each is read once, even if its mailbox is set up again.
create table crm_lead_mail_seen (
  location text not null check (length(location) between 1 and 1200),
  message_id text not null check (length(message_id) between 1 and 1000),
  lead_id bigint references crm_leads(id),
  seen_at timestamptz not null default now(),
  primary key (location, message_id)
);
`,
  };
