import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0015",
    name: "custom_reports",
    sql: `
-- Custom reports (examples CR1-CR10): a standard report's rows and columns
-- that can be changed. A draft's layout is edited; publishing keeps a frozen
-- copy (its layout and the figures worked out at that moment) that never
-- changes. Drafts and published copies can be archived and brought back;
-- only drafts can be deleted. Nothing here touches the ledger.
create table custom_reports (
  id bigserial primary key,
  kind text not null check (kind in ('draft', 'published')),
  base text not null check (base in ('profit_and_loss', 'balance_sheet')),
  title text not null check (length(title) between 1 and 200),
  layout jsonb not null,
  version integer not null default 1,
  command_source text,
  idempotency_key text,
  request_hash text,
  published_from_id bigint,
  snapshot jsonb,
  published_by_email text,
  published_at timestamptz,
  archived_by_email text,
  archived_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((command_source is null) = (idempotency_key is null) and (idempotency_key is null) = (request_hash is null)),
  check (
    (kind = 'draft' and snapshot is null and published_at is null and published_from_id is null)
    or (kind = 'published' and snapshot is not null and published_at is not null)
  ),
  check (archived_by_email is null or archived_at is not null)
);
create index custom_reports_list_idx on custom_reports (kind, (archived_at is null), updated_at desc);

-- A published copy only ever gets archived or brought back, and is never
-- deleted. A draft can be changed (its kind and base can't) or deleted.
create function tohyee_guard_custom_report() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'custom_reports can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    if old.kind = 'published' then
      raise exception 'A published report can''t be deleted; archive it instead' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if new.kind <> old.kind or new.base <> old.base or new.id <> old.id then
    raise exception 'A custom report''s kind and starting report can''t change' using errcode = 'P0001';
  end if;
  if old.kind = 'published'
     and (to_jsonb(new) - array['archived_by_email', 'archived_at'])
         <> (to_jsonb(old) - array['archived_by_email', 'archived_at']) then
    raise exception 'A published report can''t be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger custom_reports_guard
  before update or delete on custom_reports
  for each row execute function tohyee_guard_custom_report();
create trigger custom_reports_no_truncate
  before truncate on custom_reports
  for each statement execute function tohyee_guard_custom_report();
`,
  };
