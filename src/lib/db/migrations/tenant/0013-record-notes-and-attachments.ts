import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0013",
    name: "record_notes_and_attachments",
    sql: `
-- Notes and files on journals, sales invoices, bills, sales credit notes,
-- supplier credit notes and contacts (examples NF1-NF14). They post nothing.
-- A note keeps its current text; every add, edit and delete is also written
-- to audit_events with the text before and after, so the history keeps it.
create table record_notes (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  record_type text not null check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note',
                                                   'supplier_credit_note', 'contact')),
  record_id bigint not null,
  body text not null check (length(body) between 1 and 5000),
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz,
  deleted_by_email text,
  deleted_at timestamptz,
  unique (command_source, idempotency_key),
  check ((deleted_at is null) = (deleted_by_email is null))
);
create index record_notes_record_idx on record_notes (record_type, record_id, id);

-- Files, stored in the organisation's own database so its backup includes
-- them. Removing a file deletes its contents but keeps the row (name, size,
-- who added and removed it) for the history.
create table record_attachments (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  record_type text not null check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note',
                                                   'supplier_credit_note', 'contact')),
  record_id bigint not null,
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null check (content_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  removed_by_email text,
  removed_at timestamptz,
  unique (command_source, idempotency_key),
  check ((removed_at is null) = (removed_by_email is null)),
  check ((removed_at is null) = (content is not null)),
  check (content is null or octet_length(content) = byte_size)
);
create index record_attachments_record_idx on record_attachments (record_type, record_id, id);

-- A removed file stays removed, and only its removal details and contents
-- can change; rows are never deleted.
create function tohyee_guard_record_attachment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'record_attachments can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Files can''t be deleted, only removed' using errcode = 'P0001';
  end if;
  if old.removed_at is null and new.removed_at is not null and new.content is null
     and (to_jsonb(new) - array['content', 'removed_by_email', 'removed_at'])
       = (to_jsonb(old) - array['content', 'removed_by_email', 'removed_at']) then
    return new;
  end if;
  raise exception 'Files can''t be changed, only removed once' using errcode = 'P0001';
end;
$$;
create trigger record_attachments_guard
  before update or delete on record_attachments
  for each row execute function tohyee_guard_record_attachment();
create trigger record_attachments_no_truncate
  before truncate on record_attachments
  for each statement execute function tohyee_guard_record_attachment();

-- Deleted notes stay deleted; rows are never removed.
create function tohyee_guard_record_note() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'record_notes can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Notes can''t be removed from the database; delete them instead' using errcode = 'P0001';
  end if;
  if old.deleted_at is not null then
    raise exception 'A deleted note can''t be changed' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - array['body', 'version', 'updated_by_email', 'updated_at', 'deleted_by_email', 'deleted_at'])
     <> (to_jsonb(old) - array['body', 'version', 'updated_by_email', 'updated_at', 'deleted_by_email', 'deleted_at'])
     or new.version <> old.version + 1 then
    raise exception 'Only a note''s text can change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger record_notes_guard
  before update or delete on record_notes
  for each row execute function tohyee_guard_record_note();
create trigger record_notes_no_truncate
  before truncate on record_notes
  for each statement execute function tohyee_guard_record_note();

-- The history of a record reads its audit events.
create index audit_events_entity_idx on audit_events (entity_type, entity_id, id);
`,
  };
