import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0180",
    name: "private_mail_filing",
    sql: `
-- Filing an attachment from My mail into shared data (#250; examples
-- PM20-PM29, decisions 720-726). Nothing from email reaches shared data
-- unless its Owner files it, after a preview of exactly what others will
-- see. Filed items are copies: the shared row holds the file (or the rows
-- read from it) and a mark that it was filed from a private email, never
-- the email's subject, sender, text or other attachments.

-- The shared marks. The bills inbox's new source, and an optional note the
-- Owner chose to share with it; files on records filed from a private email.
alter table bill_inbox_items drop constraint bill_inbox_items_source_check;
alter table bill_inbox_items add constraint bill_inbox_items_source_check check (source in ('upload', 'mailbox', 'ai', 'my_mail'));
alter table bill_inbox_items add column note text check (note is null or length(note) between 1 and 1000);
alter table record_attachments add column filed_from_private_mail boolean not null default false;

-- The Owner's own record of what they filed (private, like the copy). It
-- goes with the copy when its history is deleted; the filed copies don't.
create table private_mail_filings (
  id bigserial primary key,
  copy_id bigint not null references private_mail_copies(id) on delete cascade,
  owner_user_id uuid not null,
  attachment_id bigint references private_mail_attachments(id) on delete set null,
  rule_id bigint,
  destination text not null check (destination in ('bills_inbox', 'soil_tests', 'pasture_readings', 'fertiliser_applications', 'record')),
  -- Where it went (ids and the place's name), and what was shared (the file's
  -- name, size and fingerprint, the note, how many rows): no email content.
  filed jsonb not null,
  filed_at timestamptz not null default now()
);
create index private_mail_filings_owner on private_mail_filings (owner_user_id, filed_at desc);

-- Rules the Owner approved once: matching attachments wait in "To file"
-- until the Owner confirms each one (decision 723). The sender and file
-- name pattern are encrypted with the copy's key, like the mail.
create table private_mail_rules (
  id bigserial primary key,
  copy_id bigint not null references private_mail_copies(id) on delete cascade,
  owner_user_id uuid not null,
  seal_ref text not null unique,
  criteria bytea not null,
  destination jsonb not null check (jsonb_typeof(destination) = 'object'),
  -- Attachments up to this id have been checked against the rule.
  checked_through bigint not null default 0,
  created_at timestamptz not null default now()
);
create index private_mail_rules_copy on private_mail_rules (copy_id);

create table private_mail_to_file (
  id bigserial primary key,
  copy_id bigint not null references private_mail_copies(id) on delete cascade,
  owner_user_id uuid not null,
  rule_id bigint not null references private_mail_rules(id) on delete cascade,
  attachment_id bigint not null references private_mail_attachments(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting', 'filed', 'dismissed')),
  filing_id bigint references private_mail_filings(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (rule_id, attachment_id)
);
create index private_mail_to_file_waiting on private_mail_to_file (owner_user_id, id) where status = 'waiting';

create trigger private_mail_filings_owner before insert or update on private_mail_filings for each row execute function private_mail_row_owner_fixed();
create trigger private_mail_rules_owner before insert or update on private_mail_rules for each row execute function private_mail_row_owner_fixed();
create trigger private_mail_to_file_owner before insert or update on private_mail_to_file for each row execute function private_mail_row_owner_fixed();
`,
  };
