import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0174",
    name: "crm_lead_replies",
    sql: `
-- Replies from leads (decision 651, #216, #360 item 17). Mail sync also
-- keeps emails with leads that aren't converted (until now only known people
-- and companies, MAIL3), linked to the lead; converting the lead links them
-- to its new person and company too.
alter table crm_participant_links add column lead_id bigint references crm_leads(id);
alter table crm_participant_links drop constraint crm_participant_links_check1;
alter table crm_participant_links add constraint crm_participant_links_target
  check (person_id is not null or contact_id is not null or lead_id is not null);
create index crm_participant_links_lead_idx on crm_participant_links (lead_id) where lead_id is not null;

-- A reply to a sales email or sequence becomes one follow-up task for the
-- record's owner. One row per reply handled (unique), made in the same
-- transaction as its task, so a check that runs twice never makes a second.
create table crm_reply_follow_ups (
  id bigserial primary key,
  reply_key text not null unique,
  message_id bigint references crm_messages(id) on delete set null,
  activity_id bigint references crm_activities(id),
  lead_id bigint references crm_leads(id),
  person_id bigint references crm_people(id),
  replied_at timestamptz not null,
  task_id bigint references crm_tasks(id),
  outcome text not null check (outcome in ('task_created', 'skipped')),
  detail text,
  created_at timestamptz not null default now(),
  check (num_nonnulls(lead_id, person_id) = 1)
);
create index crm_reply_follow_ups_lead on crm_reply_follow_ups (lead_id, replied_at) where lead_id is not null;
create index crm_reply_follow_ups_person on crm_reply_follow_ups (person_id, replied_at) where person_id is not null;

-- Replies synced from before this version are left alone, so upgrading
-- doesn't make a pile of tasks at once.
create table crm_reply_handling (
  id boolean primary key default true check (id),
  started_at timestamptz not null default now()
);
insert into crm_reply_handling (id) values (true);
`,
  };
