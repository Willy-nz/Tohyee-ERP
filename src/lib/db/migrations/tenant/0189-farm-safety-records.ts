import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0189",
    name: "farm_safety_records",
    sql: `
-- Farm health and safety records (#446, decisions 930-959, docs/FARM-SAFETY.md).
-- Every safety record (a hazard, a farm's emergency details, a report, a
-- check, a sign-off...) is kept as versions in one append-only list. Each
-- version is dated by the database when it's entered (never by the person),
-- carries the hash of the version before it, and can't be changed, deleted
-- or truncated. A correction is a new version that says why. So a change
-- made straight in the database, past these rules, shows up when the
-- history is checked (src/lib/safety/chain.ts works the hashes out again).
create function safety_entry_canonical(
  seq bigint, kind text, record_id uuid, version integer, change text, farm_id bigint,
  restricted boolean, happened_on date, entered_at timestamptz, entered_by_user_id uuid,
  entered_by_email text, via text, operation_id text, body text, previous_hash text
) returns text
language sql stable as $$
  select concat_ws(E'\n', 'tohyee-safety-entry-v1', seq::text, kind, record_id::text, version::text, change,
    coalesce(farm_id::text, ''), case when restricted then 'true' else 'false' end,
    coalesce(to_char(happened_on, 'YYYY-MM-DD'), ''),
    to_char(entered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(entered_by_user_id::text, ''), entered_by_email, coalesce(via, ''), coalesce(operation_id, ''),
    body, previous_hash)
$$;

create table safety_entries (
  seq bigint primary key,
  kind text not null check (kind in (
    'hazard', 'emergency_info', 'report', 'report_details', 'action',
    'induction', 'induction_signoff', 'visit',
    'equipment', 'checklist', 'check', 'equipment_release',
    'training', 'chemical')),
  record_id uuid not null,
  version integer not null check (version >= 1),
  change text not null check (change in ('created', 'updated', 'corrected', 'withdrawn')),
  farm_id bigint references farms(id),
  -- Incident and medical details: only for the people allowed to see them.
  restricted boolean not null default false,
  check ((kind = 'report_details') = restricted),
  -- When it happened, as the person says (may be earlier than entered_at).
  happened_on date,
  entered_at timestamptz not null default now(),
  entered_by_user_id uuid,
  entered_by_email text not null check (length(entered_by_email) between 1 and 320 and entered_by_email !~ '[\n\r]'),
  via text check (via is null or (length(via) <= 200 and via !~ '[\n\r]')),
  -- The phone's own id for this save, so sending it twice adds it once.
  operation_id text unique check (operation_id is null or operation_id ~ '^[A-Za-z0-9._:-]{8,120}$'),
  body text not null check (length(body) <= 200000 and jsonb_typeof(body::jsonb) = 'object'),
  previous_hash text not null check (previous_hash ~ '^[0-9a-f]{64}$'),
  hash text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  unique (record_id, version)
);
create index safety_entries_record on safety_entries (record_id, version desc);
create index safety_entries_farm_kind on safety_entries (farm_id, kind);

-- The database numbers, dates and chains each version; whatever the app
-- sent for these is replaced. One writer at a time keeps the chain whole.
create function safety_entries_chain() returns trigger
language plpgsql as $$
declare
  last_seq bigint;
  last_hash text;
  first_kind text;
  first_farm bigint;
  first_restricted boolean;
  latest integer;
begin
  perform pg_advisory_xact_lock(hashtext('tohyee.safety_entries'));
  new.entered_at := now();
  select e.seq, e.hash into last_seq, last_hash from safety_entries e order by e.seq desc limit 1;
  new.seq := coalesce(last_seq, 0) + 1;
  new.previous_hash := coalesce(last_hash, repeat('0', 64));
  select e.kind, e.farm_id, e.restricted into first_kind, first_farm, first_restricted
    from safety_entries e where e.record_id = new.record_id and e.version = 1;
  if new.version = 1 then
    if first_kind is not null then
      raise exception 'Safety record % already exists', new.record_id using errcode = '23505';
    end if;
    if new.change <> 'created' then
      raise exception 'A new safety record starts as created' using errcode = 'P0001';
    end if;
  else
    if first_kind is null then
      raise exception 'Safety record % not found', new.record_id using errcode = 'P0001';
    end if;
    if new.change = 'created' or new.kind <> first_kind or new.farm_id is distinct from first_farm or new.restricted <> first_restricted then
      raise exception 'A later version keeps its record''s kind and farm' using errcode = 'P0001';
    end if;
    select max(e.version) into latest from safety_entries e where e.record_id = new.record_id;
    if new.version <> latest + 1 then
      raise exception 'Safety record % has changed since it was read', new.record_id using errcode = 'P0001';
    end if;
  end if;
  new.hash := encode(sha256(convert_to(safety_entry_canonical(new.seq, new.kind, new.record_id, new.version, new.change,
    new.farm_id, new.restricted, new.happened_on, new.entered_at, new.entered_by_user_id, new.entered_by_email, new.via,
    new.operation_id, new.body, new.previous_hash), 'UTF8')), 'hex');
  return new;
end;
$$;
create trigger safety_entries_chain before insert on safety_entries
  for each row execute function safety_entries_chain();
create trigger safety_entries_append_only before update or delete on safety_entries
  for each row execute function toeyee_forbid_mutation();
create trigger safety_entries_no_truncate before truncate on safety_entries
  for each statement execute function toeyee_forbid_mutation();

-- Photos and documents (safety data sheets) kept with safety records. The
-- database works out each file's hash and the time it arrived; the photo's
-- own date (from the camera) and the phone's file date are kept as given,
-- beside it. Files can't be changed or deleted either.
create table safety_files (
  id uuid primary key,
  farm_id bigint references farms(id),
  restricted boolean not null default false,
  file_name text not null check (length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea not null,
  photo_taken text check (photo_taken is null or length(photo_taken) <= 40),
  phone_file_time timestamptz,
  received_at timestamptz not null default now(),
  uploaded_by_user_id uuid,
  uploaded_by_email text not null
);
create function safety_files_stamp() returns trigger
language plpgsql as $$
begin
  new.received_at := now();
  new.size_bytes := length(new.content);
  new.sha256 := encode(sha256(new.content), 'hex');
  return new;
end;
$$;
create trigger safety_files_stamp before insert on safety_files
  for each row execute function safety_files_stamp();
create trigger safety_files_append_only before update or delete on safety_files
  for each row execute function toeyee_forbid_mutation();
create trigger safety_files_no_truncate before truncate on safety_files
  for each statement execute function toeyee_forbid_mutation();

-- Who may see incident and medical details, besides owners and the person
-- who recorded them. Owners choose. Members live in the core database, so
-- these rows name the user by id.
create table safety_restricted_members (
  user_id uuid primary key,
  granted_by_email text not null,
  granted_at timestamptz not null default now()
);
`,
  };
