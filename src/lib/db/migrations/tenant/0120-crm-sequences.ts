import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0120",
    name: "crm_sequences",
    sql: `
-- Sequences (decision 497, #216 stage 2; Jess 10 Oct 2026: each step becomes
-- a task, and nothing is sent without a person pressing Send). A step's task
-- is made on its day; the enrolment stops on a reply, an opt-out, a closed
-- deal or an unqualified lead, or when someone stops it.
create table crm_sequences (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  description text check (description is null or length(description) <= 500),
  is_active boolean not null default true,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index crm_sequences_name on crm_sequences (lower(name));

create table crm_sequence_steps (
  id bigserial primary key,
  sequence_id bigint not null references crm_sequences(id) on delete cascade,
  position integer not null check (position between 1 and 30),
  day_offset integer not null check (day_offset between 0 and 365),
  kind text not null check (kind in ('email', 'call', 'task')),
  title text not null check (length(title) between 1 and 150),
  template_id bigint references crm_email_templates(id),
  check (kind = 'email' or template_id is null),
  unique (sequence_id, position)
);

create table crm_sequence_enrolments (
  id bigserial primary key,
  sequence_id bigint not null references crm_sequences(id),
  lead_id bigint references crm_leads(id),
  person_id bigint references crm_people(id),
  opportunity_id bigint references crm_opportunities(id),
  assignee_user_id text,
  status text not null default 'active' check (status in ('active', 'finished', 'stopped')),
  stop_reason text,
  started_on date not null,
  enrolled_by_email text,
  enrolled_at timestamptz not null default now(),
  ended_at timestamptz,
  check (num_nonnulls(lead_id, person_id, opportunity_id) = 1),
  check ((status = 'active') = (ended_at is null))
);
create unique index crm_sequence_enrolments_lead on crm_sequence_enrolments (sequence_id, lead_id) where status = 'active' and lead_id is not null;
create unique index crm_sequence_enrolments_person on crm_sequence_enrolments (sequence_id, person_id) where status = 'active' and person_id is not null;
create unique index crm_sequence_enrolments_deal on crm_sequence_enrolments (sequence_id, opportunity_id) where status = 'active' and opportunity_id is not null;
create index crm_sequence_enrolments_active on crm_sequence_enrolments (status) where status = 'active';

-- Each step of each enrolment happens once (a task made, or skipped with why).
create table crm_sequence_step_runs (
  id bigserial primary key,
  enrolment_id bigint not null references crm_sequence_enrolments(id),
  position integer not null,
  task_id bigint references crm_tasks(id),
  outcome text not null check (outcome in ('task_created', 'skipped')),
  detail text,
  ran_at timestamptz not null default now(),
  unique (enrolment_id, position)
);
`,
  };
