import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0227",
    name: "signing_requests",
    sql: `
-- E-signatures (decisions 1396-1410, docs/E-SIGNATURES.md). A signing
-- request is a PDF (kept as its exact bytes, with its SHA-256 worked out
-- by the database) and a list of signers. Each signer opens a one-time
-- link, proves they get email at their address with a code (or signs in
-- to Tohyee), and signs by typing or drawing their name. When the last one
-- signs, Tohyee keeps a signed copy with a signature page and an audit
-- certificate. Files and the signing history can't be changed or deleted;
-- a request's document never changes after it's sent (a new version is a
-- new request).
create table signing_files (
  id uuid primary key,
  kind text not null check (kind in ('document', 'signed')),
  file_name text not null check (length(file_name) between 1 and 200),
  content_type text not null check (content_type = 'application/pdf'),
  size_bytes integer not null check (size_bytes between 1 and 26214400),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea not null,
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null check (length(created_by_email) between 1 and 320)
);
create function signing_files_stamp() returns trigger
language plpgsql as $$
begin
  new.created_at := now();
  new.size_bytes := length(new.content);
  new.sha256 := encode(sha256(new.content), 'hex');
  if substring(new.content from 1 for 5) <> '\\x255044462d'::bytea then
    raise exception 'A signing file must be a PDF' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger signing_files_stamp before insert on signing_files
  for each row execute function signing_files_stamp();
create trigger signing_files_append_only before update or delete on signing_files
  for each row execute function toeyee_forbid_mutation();
create trigger signing_files_no_truncate before truncate on signing_files
  for each statement execute function toeyee_forbid_mutation();

create table signing_requests (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  title text not null check (length(title) between 1 and 200),
  -- What it's for: a quote, a year's financial statements (source_id is the
  -- year-end date), an employee's agreement, a safety induction, or any PDF.
  source_kind text not null check (source_kind in ('quote', 'year_end', 'employment', 'induction', 'upload')),
  source_id text check (source_id is null or length(source_id) between 1 and 100),
  document_file_id uuid not null references signing_files(id),
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  signing_order text not null check (signing_order in ('in_order', 'any_order')),
  message text check (message is null or length(message) between 1 and 2000),
  status text not null default 'sent' check (status in ('sent', 'completed', 'declined', 'voided')),
  expires_at timestamptz not null,
  remind_every_days integer check (remind_every_days is null or remind_every_days between 1 and 30),
  last_reminded_at timestamptz,
  replaces_request_id bigint references signing_requests(id),
  signed_file_id uuid unique references signing_files(id),
  completed_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  voided_by_user_id uuid,
  voided_by_email text,
  void_reason text check (void_reason is null or length(void_reason) between 1 and 1000),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((status = 'completed') = (signed_file_id is not null and completed_at is not null)),
  check ((status = 'voided') = (voided_at is not null and void_reason is not null)),
  check ((status = 'declined') = (declined_at is not null))
);
create index signing_requests_source on signing_requests (source_kind, source_id);
create index signing_requests_open on signing_requests (expires_at) where status = 'sent';

create table signing_signers (
  id bigserial primary key,
  request_id bigint not null references signing_requests(id),
  position integer not null check (position between 1 and 20),
  name text not null check (length(name) between 1 and 150),
  email text not null check (length(email) between 3 and 320),
  -- A member of the organisation signing: they can also sign in Tohyee.
  user_id uuid,
  role_label text check (role_label is null or length(role_label) between 1 and 100),
  -- waiting: not their turn yet (in order); ready: their link works.
  status text not null default 'waiting' check (status in ('waiting', 'ready', 'signed', 'declined')),
  token_hash text unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  link_sent_at timestamptz,
  code_hash text check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz,
  code_attempts integer not null default 0 check (code_attempts >= 0),
  codes_sent integer not null default 0 check (codes_sent >= 0),
  code_sent_at timestamptz,
  verified_at timestamptz,
  verified_by text check (verified_by is null or verified_by in ('email_code', 'tohyee_sign_in')),
  session_hash text unique check (session_hash is null or session_hash ~ '^[0-9a-f]{64}$'),
  session_expires_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  method text check (method is null or method in ('typed', 'drawn')),
  typed_name text check (typed_name is null or length(typed_name) between 1 and 150),
  signature_png bytea check (signature_png is null or length(signature_png) between 1 and 262144),
  consent_text text check (consent_text is null or length(consent_text) between 1 and 200),
  signed_sha256 text check (signed_sha256 is null or signed_sha256 ~ '^[0-9a-f]{64}$'),
  ip_address text check (ip_address is null or length(ip_address) <= 100),
  user_agent text check (user_agent is null or length(user_agent) <= 500),
  decline_reason text check (decline_reason is null or length(decline_reason) between 1 and 1000),
  declined_at timestamptz,
  copy_token_hash text unique check (copy_token_hash is null or copy_token_hash ~ '^[0-9a-f]{64}$'),
  copy_expires_at timestamptz,
  unique (request_id, position),
  check ((status = 'signed') = (signed_at is not null)),
  check (status <> 'signed' or (method is not null and typed_name is not null and consent_text is not null and signed_sha256 is not null and verified_at is not null)),
  check (method is null or (method = 'drawn') = (signature_png is not null)),
  check ((status = 'declined') = (declined_at is not null and decline_reason is not null))
);
create index signing_signers_user on signing_signers (user_id) where user_id is not null;

-- What happened, in order, for the audit certificate. The database dates
-- each entry; entries can't be changed or deleted.
create table signing_events (
  id bigserial primary key,
  request_id bigint not null references signing_requests(id),
  signer_id bigint references signing_signers(id),
  event text not null check (event in ('sent', 'link_emailed', 'link_opened', 'code_sent', 'verified', 'viewed', 'signed', 'declined', 'voided', 'completed', 'reminded', 'link_resent', 'expired')),
  at timestamptz not null default now(),
  actor_email text check (actor_email is null or length(actor_email) <= 320),
  ip_address text check (ip_address is null or length(ip_address) <= 100),
  user_agent text check (user_agent is null or length(user_agent) <= 500),
  details jsonb not null default '{}'::jsonb
);
create index signing_events_request on signing_events (request_id, id);
create function signing_events_stamp() returns trigger
language plpgsql as $$
begin
  new.at := now();
  return new;
end;
$$;
create trigger signing_events_stamp before insert on signing_events
  for each row execute function signing_events_stamp();
create trigger signing_events_append_only before update or delete on signing_events
  for each row execute function toeyee_forbid_mutation();
create trigger signing_events_no_truncate before truncate on signing_events
  for each statement execute function toeyee_forbid_mutation();

-- A request's document is checked against its file, and never changes. Only
-- an open request moves on (completed, declined or voided), once.
create function signing_requests_guard() returns trigger
language plpgsql as $$
declare
  moving text[] := array['status', 'signed_file_id', 'completed_at', 'declined_at', 'voided_at', 'voided_by_user_id',
    'voided_by_email', 'void_reason', 'last_reminded_at'];
  file_sha text;
  file_kind text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'signing requests can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    select sha256, kind into file_sha, file_kind from signing_files where id = new.document_file_id;
    if file_sha is distinct from new.document_sha256 or file_kind <> 'document' then
      raise exception 'The signing request''s fingerprint doesn''t match its document' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Signing request % can''t be deleted: void it instead', old.id using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - moving) <> (to_jsonb(old) - moving) then
    raise exception 'Signing request % can''t be changed after it''s sent: send a new request instead', old.id using errcode = 'P0001';
  end if;
  if old.status <> 'sent' and (to_jsonb(new) <> to_jsonb(old)) then
    raise exception 'Signing request % is %, so it can''t be changed', old.id, old.status using errcode = 'P0001';
  end if;
  if new.signed_file_id is not null and new.signed_file_id is distinct from old.signed_file_id
     and not exists (select 1 from signing_files where id = new.signed_file_id and kind = 'signed') then
    raise exception 'The signed copy must be a signed file' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger signing_requests_guard before insert or update or delete on signing_requests
  for each row execute function signing_requests_guard();
create trigger signing_requests_no_truncate before truncate on signing_requests
  for each statement execute function signing_requests_guard();

-- Who signs never changes. Once someone has signed or declined, what they
-- did is fixed: only their used link, session and copy link can be cleared
-- or set.
create function signing_signers_guard() returns trigger
language plpgsql as $$
declare
  fixed text[] := array['request_id', 'position', 'name', 'email', 'user_id', 'role_label'];
  after_done text[] := array['token_hash', 'session_hash', 'session_expires_at', 'copy_token_hash', 'copy_expires_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'signers can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A signer can''t be removed from a signing request' using errcode = 'P0001';
  end if;
  if (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(new)) where key = any(fixed))
     <> (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(old)) where key = any(fixed)) then
    raise exception 'Who signs can''t be changed after a request is sent' using errcode = 'P0001';
  end if;
  if old.status in ('signed', 'declined') and (to_jsonb(new) - after_done) <> (to_jsonb(old) - after_done) then
    raise exception 'A signature or decline can''t be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger signing_signers_guard before update or delete on signing_signers
  for each row execute function signing_signers_guard();
create trigger signing_signers_no_truncate before truncate on signing_signers
  for each statement execute function signing_signers_guard();

-- Emails about signing (links, codes, reminders, finished copies), sent
-- through the organisation's own email like approval and roster emails.
create table signing_emails (
  id bigserial primary key,
  request_id bigint not null references signing_requests(id),
  signer_id bigint references signing_signers(id),
  purpose text not null check (purpose in ('link', 'code', 'reminder', 'completed', 'declined', 'voided')),
  to_email text not null check (length(to_email) between 1 and 320),
  subject text not null check (length(subject) between 1 and 250),
  body text not null check (length(body) between 1 and 5000),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index signing_emails_due on signing_emails (next_attempt_at) where status in ('queued', 'sending');
create index signing_emails_request on signing_emails (request_id, id);

-- A quote the customer accepts by signing is accepted with no invoice or
-- sales order yet (QT9, as Xero does); one is made from it afterwards
-- (QT10), once.
alter table quotes add column accepted_signing_request_id bigint unique references signing_requests(id);
alter table quotes add column invoice_command_source text;
alter table quotes add column invoice_idempotency_key text;
alter table quotes add column invoice_request_hash text;
alter table quotes add constraint quotes_invoice_command_unique unique (invoice_command_source, invoice_idempotency_key);
alter table quotes drop constraint quotes_accepted_check;
alter table quotes add constraint quotes_accepted_check
  check ((status = 'accepted') = (invoice_id is not null or sales_order_id is not null or accepted_signing_request_id is not null)
         and (invoice_id is null or sales_order_id is null)
         and (accepted_signing_request_id is null or status = 'accepted'));

create or replace function tohyee_guard_quote() returns trigger
language plpgsql as $$
declare
  close_columns text[] := array['status', 'invoice_id', 'sales_order_id', 'close_command_source', 'close_idempotency_key',
    'close_request_hash', 'closed_by_user_id', 'closed_by_email', 'closed_at', 'updated_at', 'accepted_signing_request_id'];
  make_columns text[] := array['invoice_id', 'sales_order_id', 'invoice_command_source', 'invoice_idempotency_key',
    'invoice_request_hash', 'updated_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'quotes can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Quote % is %, so it can''t be deleted', old.quote_number, old.status using errcode = 'P0001';
  end if;
  if old.status = 'finalised' and new.status in ('accepted', 'declined')
     and (to_jsonb(new) - close_columns) = (to_jsonb(old) - close_columns) then
    return new;
  end if;
  -- Accepted by signing, then made into an invoice or a sales order, once.
  if old.status = 'accepted' and old.accepted_signing_request_id is not null
     and old.invoice_id is null and old.sales_order_id is null
     and (new.invoice_id is not null or new.sales_order_id is not null)
     and (to_jsonb(new) - make_columns) = (to_jsonb(old) - make_columns) then
    return new;
  end if;
  raise exception 'Quote % is %, so it can''t be changed', old.quote_number, old.status using errcode = 'P0001';
end;
$$;
`,
  };
