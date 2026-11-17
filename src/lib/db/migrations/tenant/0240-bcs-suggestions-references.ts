import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0240",
    name: "bcs_suggestions_references",
    sql: `
-- AI suggestions from photos and the farm's reference photos (decisions
-- 1491-1494). A suggestion is never a score: a person accepts (as is or
-- changed) or declines it, and only an accepted one makes a record.
-- A reference photo is one a person marked, with the score they gave it
-- by eye, so the person's AI can compare against the farm's own stock.
alter table bcs_photos add column reference_kind text;
alter table bcs_photos add column reference_scale text check (reference_scale is null or reference_scale in ('1_10', '1_5'));
alter table bcs_photos add column reference_score numeric(3, 1) check (reference_score is null or (reference_score >= 1 and reference_score <= 10));
alter table bcs_photos add column reference_marked_by_email text;
alter table bcs_photos add column reference_marked_at timestamptz;
alter table bcs_photos add constraint bcs_photos_reference_check check ((reference_score is null) = (reference_kind is null) and (reference_score is null) = (reference_scale is null) and (reference_score is null) = (reference_marked_at is null));
create index bcs_photos_references on bcs_photos (reference_kind, reference_score) where reference_score is not null and status = 'active';

create table bcs_suggestions (
  id bigserial primary key,
  farm_id bigint not null references farms(id),
  animal_id bigint references animals(id),
  mob_id bigint references mobs(id),
  photo_id bigint not null references bcs_photos(id),
  scale text not null check (scale in ('1_10', '1_5')),
  score numeric(3, 1) not null check (score >= 1 and score <= 10),
  estimated_kg numeric(7, 1) check (estimated_kg is null or (estimated_kg > 0 and estimated_kg <= 2000)),
  reasoning text not null check (length(reasoning) between 1 and 500),
  reference_photo_ids bigint[] not null default '{}',
  ai_key_name text,
  proposed_by_user_id uuid,
  proposed_by_email text not null,
  idempotency_key text not null unique,
  request_hash text not null,
  created_at timestamptz not null default now(),
  status text not null default 'waiting' check (status in ('waiting', 'accepted', 'declined')),
  decided_score numeric(3, 1),
  decided_kg numeric(7, 1),
  bcs_record_id bigint references bcs_records(id),
  animal_weight_id bigint references animal_weights(id),
  mob_event_id bigint references mob_events(id),
  decided_by_email text,
  decided_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) between 1 and 500),
  check ((animal_id is null) <> (mob_id is null)),
  check ((status = 'waiting') = (decided_at is null)),
  check ((status = 'accepted') = (bcs_record_id is not null and decided_score is not null)),
  check (decline_reason is null or status = 'declined')
);
create index bcs_suggestions_farm on bcs_suggestions (farm_id, status);
create trigger bcs_suggestions_no_delete before delete on bcs_suggestions for each row execute function toeyee_forbid_delete();
alter table bcs_records add column suggestion_id bigint references bcs_suggestions(id);
`,
  };
