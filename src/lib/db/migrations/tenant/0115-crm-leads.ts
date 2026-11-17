import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0115",
    name: "crm_leads",
    sql: `
-- Leads (decision 492, #216): enquiries before they're customers, after
-- Salesforce's leads. Typed in, imported from a spreadsheet, sent from a web
-- form or emailed in; worked, then converted into a company, a person and
-- optionally an opportunity, keeping their tasks and activities. Never deleted.
create table crm_leads (
  id bigserial primary key,
  command_source text,
  idempotency_key text,
  first_name text check (first_name is null or length(first_name) between 1 and 100),
  last_name text check (last_name is null or length(last_name) between 1 and 100),
  company_name text check (company_name is null or length(company_name) between 1 and 200),
  email text check (email is null or length(email) <= 254),
  phone text check (phone is null or length(phone) <= 50),
  job_title text check (job_title is null or length(job_title) <= 100),
  description text check (description is null or length(description) <= 4000),
  source text not null check (source in ('manual', 'import', 'web_form', 'email')),
  source_detail text check (source_detail is null or length(source_detail) <= 300),
  status text not null default 'new' check (status in ('new', 'working', 'unqualified', 'converted')),
  unqualified_reason text check (unqualified_reason is null or length(unqualified_reason) <= 500),
  needs_review boolean not null default false,
  owner_user_id text,
  converted_at timestamptz,
  converted_contact_id bigint references contacts(id),
  converted_person_id bigint references crm_people(id),
  converted_opportunity_id bigint references crm_opportunities(id),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (first_name is not null or last_name is not null or company_name is not null or email is not null),
  check ((status = 'converted') = (converted_at is not null)),
  check (status <> 'converted' or (converted_contact_id is not null and converted_person_id is not null)),
  check (status <> 'unqualified' or unqualified_reason is not null)
);
create index crm_leads_owner on crm_leads (owner_user_id, status);
create index crm_leads_email on crm_leads (lower(email)) where email is not null;
create trigger crm_leads_no_delete before delete on crm_leads for each row execute function toeyee_forbid_delete();
create trigger crm_leads_no_truncate before truncate on crm_leads for each statement execute function toeyee_forbid_delete();

-- A lead's tasks and activities; on conversion they also get its new company and person.
alter table crm_tasks add column lead_id bigint references crm_leads(id);
alter table crm_activities add column lead_id bigint references crm_leads(id);
alter table crm_activities drop constraint crm_activities_check;
alter table crm_activities add constraint crm_activities_check
  check (contact_id is not null or person_id is not null or opportunity_id is not null or lead_id is not null);
create index crm_tasks_lead on crm_tasks (lead_id) where lead_id is not null;
create index crm_activities_lead on crm_activities (lead_id) where lead_id is not null;
`,
  };
