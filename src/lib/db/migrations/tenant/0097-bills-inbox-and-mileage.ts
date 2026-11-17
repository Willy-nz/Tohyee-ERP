import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0097",
    name: "bills_inbox_and_mileage",
    sql: `
-- Bills inbox mailboxes (BI2, decisions 404-406): one mailbox folder or Gmail
-- label read through an admin's own CRM mailbox, or IMAP with an app password
-- (stored encrypted). PDF and image attachments become inbox items.
create table bill_inbox_mailboxes (
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
  last_files_added integer check (last_files_added >= 0),
  last_files_skipped integer check (last_files_skipped >= 0),
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mail_kind <> 'imap' or (imap_host is not null and imap_username is not null and imap_password_ciphertext is not null))
);

-- Messages a mailbox place has given the inbox: each is read once (BI2), and
-- removing the mailbox doesn't forget them.
create table bill_inbox_mail_seen (
  location text not null check (length(location) between 1 and 1200),
  message_id text not null check (length(message_id) between 1 and 1000),
  files_added integer not null default 0 check (files_added >= 0),
  seen_at timestamptz not null default now(),
  primary key (location, message_id)
);

-- The bills inbox (BI1-BI7): supplier bills and receipts that arrived but
-- aren't bills yet. Nothing here posts. An item is waiting until a bill is
-- made from it (bill_id) or someone removes it with a reason; a removed
-- item's file is dropped and the row kept for the history.
create table bill_inbox_items (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  source text not null check (source in ('upload', 'mailbox', 'ai')),
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea,
  mailbox_id bigint references bill_inbox_mailboxes(id) on delete set null,
  email_from text check (email_from is null or length(email_from) <= 500),
  email_subject text check (email_subject is null or length(email_subject) <= 1000),
  email_date timestamptz,
  bill_id bigint references bills(id) on delete set null,
  made_by_email text,
  made_via text,
  made_at timestamptz,
  removed_at timestamptz,
  removed_by_email text,
  removed_reason text check (removed_reason is null or length(removed_reason) between 1 and 500),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((removed_at is null) = (removed_by_email is null)),
  check ((removed_at is null) = (removed_reason is null)),
  check ((removed_at is null) = (content is not null)),
  check (removed_at is null or bill_id is null),
  check (content is null or octet_length(content) = byte_size)
);
create unique index bill_inbox_items_bill_once on bill_inbox_items (bill_id) where bill_id is not null;
create index bill_inbox_items_sha256_idx on bill_inbox_items (sha256);
create index bill_inbox_items_waiting_idx on bill_inbox_items (id) where bill_id is null and removed_at is null;

-- IRD kilometre rates per income year (1 April - 31 March, named by the year
-- it ends) and vehicle type (MI1, decisions 407-410). Admins enter them; a
-- year's rates are fixed once an approved claim used them. Tohyee starts
-- with the rates IRD published for 2025-26 (OS 19/04).
create table mileage_rates (
  year_ending integer not null check (year_ending between 2000 and 2200),
  vehicle_type text not null check (vehicle_type in ('petrol', 'diesel', 'petrol_hybrid', 'electric')),
  tier1_rate numeric not null check (tier1_rate > 0 and tier1_rate < 100 and scale(tier1_rate) <= 4),
  tier2_rate numeric not null check (tier2_rate > 0 and tier2_rate < 100 and scale(tier2_rate) <= 4),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  primary key (year_ending, vehicle_type)
);
insert into mileage_rates (year_ending, vehicle_type, tier1_rate, tier2_rate, updated_by_email) values
  (2026, 'petrol', 1.20, 0.37, 'tohyee'),
  (2026, 'diesel', 1.30, 0.38, 'tohyee'),
  (2026, 'petrol_hybrid', 0.90, 0.24, 'tohyee'),
  (2026, 'electric', 1.22, 0.23, 'tohyee');

-- Mileage lines on expense claims (MI2-MI7): kilometres times the kilometre
-- rate, with how it was worked out kept on the line. No GST (question 4).
alter table expense_claim_receipts
  add column kind text not null default 'receipt' check (kind in ('receipt', 'mileage')),
  add column from_place text check (from_place is null or length(from_place) between 1 and 200),
  add column to_place text check (to_place is null or length(to_place) between 1 and 200),
  add column km numeric check (km is null or (km > 0 and km <= 2000 and scale(km) <= 1)),
  add column vehicle_type text check (vehicle_type is null or vehicle_type in ('petrol', 'diesel', 'petrol_hybrid', 'electric')),
  add column rate_year_ending integer,
  add column tier1_km numeric check (tier1_km is null or tier1_km >= 0),
  add column tier1_rate numeric check (tier1_rate is null or tier1_rate > 0),
  add column tier2_km numeric check (tier2_km is null or tier2_km >= 0),
  add column tier2_rate numeric check (tier2_rate is null or tier2_rate > 0),
  add column rate_note text check (rate_note is null or length(rate_note) <= 200),
  add column tier_override text check (tier_override is null or tier_override in ('tier1', 'tier2')),
  add constraint expense_claim_receipts_mileage_check check (
    (kind = 'receipt' and km is null and vehicle_type is null and from_place is null and to_place is null and rate_year_ending is null
       and tier1_km is null and tier1_rate is null and tier2_km is null and tier2_rate is null and rate_note is null and tier_override is null)
    or (kind = 'mileage' and km is not null and vehicle_type is not null and from_place is not null and to_place is not null
       and rate_year_ending is not null and tier1_km is not null and tier1_rate is not null and tier2_km is not null and tier2_rate is not null
       and tier1_km + tier2_km = km and tax_code_id is null and tax_amount = 0 and supplier_gst_number is null)
  );
`,
  };
