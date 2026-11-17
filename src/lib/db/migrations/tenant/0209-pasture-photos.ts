import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0209",
    name: "pasture_photos",
    sql: `
-- Photos with cover readings and AI estimates from them (#503, decisions
-- 1160-1169). A photo is kept as it arrived: the database works out its
-- size, hash and the time it arrived; the camera's date, the phone's file
-- time and where the phone said it was are kept beside it as given. Only
-- removing it (hidden, kept for the history) changes a row.
create table pasture_photos (
  id uuid primary key,
  farm_id bigint not null references farms(id),
  paddock_id bigint not null references paddocks(id),
  -- The Log's reading this photo was taken with (its operation id), when there was one.
  reading_operation_id uuid,
  file_name text not null check (length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea not null,
  photo_taken text check (photo_taken is null or length(photo_taken) <= 40),
  phone_file_time timestamptz,
  -- The day it was taken: the phone's time when it gave a sensible one, else the day it arrived.
  taken_on date not null,
  place jsonb check (place is null or (jsonb_typeof(place) = 'object' and (place ? 'latitude') and (place ? 'longitude'))),
  note text check (note is null or length(note) between 1 and 200),
  received_at timestamptz not null default now(),
  uploaded_by_user_id uuid,
  uploaded_by_email text not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_by_email text,
  removed_at timestamptz,
  check ((status = 'removed') = (removed_at is not null))
);
create index pasture_photos_paddock on pasture_photos (paddock_id, taken_on) where status = 'active';
create index pasture_photos_reading on pasture_photos (reading_operation_id) where reading_operation_id is not null;
create function pasture_photos_stamp() returns trigger
language plpgsql as $$
begin
  new.received_at := now();
  new.size_bytes := length(new.content);
  new.sha256 := encode(sha256(new.content), 'hex');
  return new;
end;
$$;
create trigger pasture_photos_stamp before insert on pasture_photos
  for each row execute function pasture_photos_stamp();
-- Only removing: the photo, its times and place never change.
create function pasture_photos_only_remove() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.status <> 'active' or new.status <> 'removed'
     or (to_jsonb(new) - array['status', 'removed_by_email', 'removed_at']) <> (to_jsonb(old) - array['status', 'removed_by_email', 'removed_at']) then
    raise exception 'A pasture photo can''t be changed or deleted, only removed.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger pasture_photos_only_remove before update or delete on pasture_photos
  for each row execute function pasture_photos_only_remove();
-- Emptying either table is refused too (not with toeyee_forbid_mutation: these rows can be removed or decided).
create function tohyee_forbid_pasture_photo_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'Pasture photos and their estimates can''t be emptied.' using errcode = 'P0001';
end;
$$;
create trigger pasture_photos_no_truncate before truncate on pasture_photos
  for each statement execute function tohyee_forbid_pasture_photo_truncate();

-- An AI's cover estimate from a photo: a proposal, never a reading, until a
-- person accepts it (as proposed, or changed) or keeps it beside the
-- photo's own reading for comparison; or declines it. Decided once.
create table pasture_photo_estimates (
  id bigserial primary key,
  photo_id uuid not null unique references pasture_photos(id),
  farm_id bigint not null references farms(id),
  paddock_id bigint not null references paddocks(id),
  idempotency_key text not null unique,
  request_hash text not null,
  cover integer not null check (cover between 0 and 20000),
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  reasoning text not null check (length(reasoning) between 1 and 500),
  ai_key_name text,
  proposed_by_user_id uuid,
  proposed_by_email text not null,
  created_at timestamptz not null default now(),
  status text not null default 'waiting' check (status in ('waiting', 'accepted', 'changed', 'compared', 'declined')),
  decided_cover integer check (decided_cover between 0 and 20000),
  reading_id bigint references pasture_readings(id),
  decided_by_email text,
  decided_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) between 1 and 500),
  check ((status = 'waiting') = (decided_at is null)),
  check ((status in ('accepted', 'changed')) = (reading_id is not null and decided_cover is not null)),
  check (status <> 'accepted' or decided_cover = cover),
  check (status <> 'changed' or decided_cover <> cover),
  check (decline_reason is null or status = 'declined')
);
create index pasture_photo_estimates_waiting on pasture_photo_estimates (farm_id) where status = 'waiting';
create function pasture_photo_estimates_decide_once() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.status <> 'waiting'
     or (to_jsonb(new) - array['status', 'decided_cover', 'reading_id', 'decided_by_email', 'decided_at', 'decline_reason'])
        <> (to_jsonb(old) - array['status', 'decided_cover', 'reading_id', 'decided_by_email', 'decided_at', 'decline_reason']) then
    raise exception 'A photo estimate is decided once and then kept as it is.' using errcode = 'P0001';
  end if;
  new.decided_at := now();
  return new;
end;
$$;
create trigger pasture_photo_estimates_decide_once before update or delete on pasture_photo_estimates
  for each row execute function pasture_photo_estimates_decide_once();
create trigger pasture_photo_estimates_no_truncate before truncate on pasture_photo_estimates
  for each statement execute function tohyee_forbid_pasture_photo_truncate();

-- Readings made by accepting an estimate are labelled as such.
alter table pasture_readings drop constraint pasture_readings_method_check;
alter table pasture_readings add constraint pasture_readings_method_check check (method in ('plate_meter', 'visual', 'measured_other', 'satellite', 'model', 'photo_ai'));
`,
  };
