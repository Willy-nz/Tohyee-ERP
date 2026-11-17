import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0035",
    name: "document_emails",
    sql: `
-- Emailing invoices, credit notes, quotes, purchase orders and customer
-- statements from the organisation's own email account (Gmail, Microsoft 365
-- or any SMTP server). The account's password is encrypted with the server's
-- TOHYEE_SECRET_KEY (the same encryption as other stored secrets) and is
-- never sent back to the browser.
create table organisation_email_settings (
  id boolean primary key default true check (id),
  from_name text not null check (length(from_name) between 1 and 100),
  from_address text not null check (length(from_address) between 3 and 254),
  reply_to text check (reply_to is null or length(reply_to) between 3 and 254),
  smtp_host text not null check (smtp_host ~ '^[a-z0-9.-]{1,200}$' or smtp_host = '::1'),
  smtp_port integer not null check (smtp_port between 1 and 65535),
  smtp_security text not null check (smtp_security in ('ssl', 'starttls', 'none')),
  smtp_username text not null check (length(smtp_username) between 1 and 254),
  smtp_password_ciphertext text not null,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_error text
);

-- The subject and message each kind of document's email starts with. No
-- row means Tohyee's default template.
create table email_templates (
  document_kind text primary key
    check (document_kind in ('invoice', 'credit_note', 'quote', 'purchase_order', 'statement')),
  subject text not null check (length(subject) between 1 and 250),
  body text not null check (length(body) between 1 and 10000),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

-- A run of "email statements to every customer with a balance".
create table document_email_batches (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  statement jsonb not null,
  requested_by_user_id uuid,
  requested_by_email text not null,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);

-- Each email asked for: queued, then sent or failed by the background job.
-- 'sent' is only ever set when the SMTP server accepted the message (its
-- message id and reply are kept). What the email says and who it goes to
-- can't change once queued, finished emails can't change at all, and none
-- are ever deleted.
create table document_emails (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  document_kind text not null
    check (document_kind in ('invoice', 'credit_note', 'quote', 'purchase_order', 'statement')),
  -- The invoice, credit note, quote or purchase order; for a statement, the customer.
  document_id bigint not null,
  contact_id bigint not null references contacts(id),
  statement jsonb check ((document_kind = 'statement') = (statement is not null)),
  batch_id bigint references document_email_batches(id),
  to_addresses text[] not null check (cardinality(to_addresses) between 1 and 20),
  cc_addresses text[] not null default '{}' check (cardinality(cc_addresses) <= 20),
  subject text not null check (length(subject) between 1 and 250),
  body text not null check (length(body) between 1 and 10000),
  attachment_name text not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  message_id text,
  smtp_response text,
  attachment_sha256 text,
  attachment_bytes integer,
  requested_by_user_id uuid,
  requested_by_email text not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (command_source, idempotency_key),
  check (status <> 'sent' or (message_id is not null and finished_at is not null and attachment_sha256 is not null)),
  check (status <> 'failed' or (last_error is not null and finished_at is not null))
);
create index document_emails_document on document_emails (document_kind, document_id, id);
create index document_emails_due on document_emails (next_attempt_at) where status in ('queued', 'sending');
create index document_emails_batch on document_emails (batch_id) where batch_id is not null;
create index document_emails_created on document_emails (created_at);

create function tohyee_guard_document_email() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'Emails are kept as a record of what was sent; they can''t be deleted' using errcode = 'P0001';
  end if;
  if old.status in ('sent', 'failed') then
    raise exception 'Email % has finished and can''t be changed; send it again instead', old.id using errcode = 'P0001';
  end if;
  if new.document_kind is distinct from old.document_kind or new.document_id is distinct from old.document_id
     or new.contact_id is distinct from old.contact_id or new.statement is distinct from old.statement
     or new.batch_id is distinct from old.batch_id or new.to_addresses is distinct from old.to_addresses
     or new.cc_addresses is distinct from old.cc_addresses or new.subject is distinct from old.subject
     or new.body is distinct from old.body or new.attachment_name is distinct from old.attachment_name
     or new.requested_by_email is distinct from old.requested_by_email
     or new.requested_by_user_id is distinct from old.requested_by_user_id or new.created_at is distinct from old.created_at
     or new.request_hash is distinct from old.request_hash or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'What an email says and who it goes to can''t change once it''s queued' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger document_emails_guard
  before update or delete on document_emails
  for each row execute function tohyee_guard_document_email();
create trigger document_emails_no_truncate
  before truncate on document_emails
  for each statement execute function tohyee_guard_document_email();
create function tohyee_guard_document_email_batch() returns trigger
language plpgsql as $$
begin
  raise exception 'Statement runs are kept as a record of what was sent; they can''t be changed or deleted' using errcode = 'P0001';
end;
$$;
create trigger document_email_batches_guard
  before update or delete on document_email_batches
  for each row execute function tohyee_guard_document_email_batch();
create trigger document_email_batches_no_truncate
  before truncate on document_email_batches
  for each statement execute function tohyee_guard_document_email_batch();
`,
  };
