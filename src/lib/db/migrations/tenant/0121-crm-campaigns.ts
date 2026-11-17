import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0121",
    name: "crm_campaigns",
    sql: `
-- Campaigns (decision 498, #216 stage 2; Jess 10 Oct 2026). Each lead and
-- deal has at most one source campaign, so revenue is counted once. Budget
-- and cost are typed in for reports; nothing goes into the books.
create table crm_campaigns (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  kind text not null default 'other' check (kind in ('email', 'event', 'advert', 'social', 'referral', 'other')),
  status text not null default 'planned' check (status in ('planned', 'active', 'finished')),
  start_date date,
  end_date date,
  budget numeric(18, 2) check (budget is null or budget >= 0),
  actual_cost numeric(18, 2) check (actual_cost is null or actual_cost >= 0),
  description text check (description is null or length(description) <= 1000),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create unique index crm_campaigns_name on crm_campaigns (lower(name));

create table crm_campaign_members (
  id bigserial primary key,
  campaign_id bigint not null references crm_campaigns(id),
  lead_id bigint references crm_leads(id),
  person_id bigint references crm_people(id),
  status text not null default 'added' check (status in ('added', 'sent', 'responded')),
  responded_at timestamptz,
  added_by_email text,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(lead_id, person_id) = 1)
);
create unique index crm_campaign_members_lead on crm_campaign_members (campaign_id, lead_id) where lead_id is not null;
create unique index crm_campaign_members_person on crm_campaign_members (campaign_id, person_id) where person_id is not null;
create index crm_campaign_members_open on crm_campaign_members (status) where status <> 'responded';

alter table crm_leads add column source_campaign_id bigint references crm_campaigns(id);
alter table crm_opportunities add column source_campaign_id bigint references crm_campaigns(id);
alter table crm_lead_forms add column campaign_id bigint references crm_campaigns(id);
alter table crm_lead_mailboxes add column campaign_id bigint references crm_campaigns(id);
create index crm_leads_source_campaign on crm_leads (source_campaign_id) where source_campaign_id is not null;
create index crm_opportunities_source_campaign on crm_opportunities (source_campaign_id) where source_campaign_id is not null;
`,
  };
