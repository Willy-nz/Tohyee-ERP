import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0175",
    name: "crm_account_plans_and_renewals",
    sql: `
-- Account plans and renewal reminders (decisions 653-654, #216 stage 4;
-- #360 item 17), after Salesforce's account plans and HubSpot's buying
-- roles. One plan per company: where things stand, its goals, and the
-- part each of its people plays. The next steps are the company's tasks.
create table crm_account_plans (
  contact_id bigint primary key references contacts(id),
  summary text check (summary is null or length(summary) <= 4000),
  updated_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table crm_account_plan_goals (
  id bigserial primary key,
  contact_id bigint not null references crm_account_plans(contact_id),
  position integer not null check (position between 1 and 50),
  title text not null check (length(title) between 1 and 200),
  target_date date,
  status text not null default 'open' check (status in ('open', 'achieved', 'dropped')),
  unique (contact_id, position)
);

create table crm_account_plan_people (
  person_id bigint primary key references crm_people(id),
  contact_id bigint not null references crm_account_plans(contact_id),
  role text not null check (role in ('decision_maker', 'budget_holder', 'champion', 'influencer', 'user', 'blocker', 'other')),
  note text check (note is null or length(note) <= 300)
);
create index crm_account_plan_people_contact on crm_account_plan_people (contact_id);

-- Renewal dates on a deal and on its product lines (CRM only; nothing in the books).
alter table crm_opportunities add column renewal_date date;
alter table crm_opportunity_lines add column renewal_date date;
create index crm_opportunities_renewal on crm_opportunities (renewal_date) where renewal_date is not null;

-- A follow-up rule that reminds the deal's owner N days before a renewal.
alter table crm_follow_up_rules drop constraint crm_follow_up_rules_kind_check;
alter table crm_follow_up_rules add constraint crm_follow_up_rules_kind_check
  check (kind in ('lead_arrives', 'deal_stage', 'deal_quiet', 'task_overdue', 'renewal_due'));
`,
  };
