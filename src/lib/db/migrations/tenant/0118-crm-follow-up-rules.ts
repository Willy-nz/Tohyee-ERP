import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0118",
    name: "crm_follow_up_rules",
    sql: `
-- Follow-up rules (decision 495, #216 stage 2): each makes a task for the
-- right person when a lead arrives, a deal reaches a stage, a deal goes
-- quiet or a task is overdue. A run is kept per rule and per event, so a
-- check that runs twice never makes a second task.
create table crm_follow_up_rules (
  id bigserial primary key,
  kind text not null check (kind in ('lead_arrives', 'deal_stage', 'deal_quiet', 'task_overdue')),
  name text not null check (length(name) between 1 and 100),
  stage_key text,
  days integer not null check (days between 0 and 365),
  task_title text check (task_title is null or length(task_title) between 1 and 150),
  is_active boolean not null default true,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'deal_stage') = (stage_key is not null)),
  check (kind not in ('deal_quiet', 'task_overdue') or days >= 1)
);

create table crm_follow_up_runs (
  id bigserial primary key,
  rule_id bigint not null references crm_follow_up_rules(id) on delete cascade,
  run_key text not null,
  task_id bigint references crm_tasks(id),
  lead_id bigint references crm_leads(id),
  opportunity_id bigint references crm_opportunities(id),
  source_task_id bigint references crm_tasks(id),
  outcome text not null check (outcome in ('task_created', 'skipped')),
  detail text,
  ran_at timestamptz not null default now(),
  unique (rule_id, run_key)
);
create index crm_follow_up_runs_recent on crm_follow_up_runs (ran_at desc);
create index crm_follow_up_runs_task on crm_follow_up_runs (task_id);
`,
  };
