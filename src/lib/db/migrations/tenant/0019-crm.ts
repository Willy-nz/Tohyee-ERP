import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0019",
    name: "crm",
    sql: `
-- The CRM module (examples MOD1, CRM1-CRM9), after Twenty's companies,
-- people, opportunities, tasks and notes. Companies are contacts; a contact
-- can now be a prospect as well as (or instead of) a customer or supplier.
alter table organisation_settings add column crm_enabled boolean not null default false;

do $$
declare
  name text;
begin
  select conname into name from pg_constraint
   where conrelid = 'contacts'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%is_customer OR is_supplier%';
  if name is not null then
    execute format('alter table contacts drop constraint %I', name);
  end if;
end;
$$;
alter table contacts add column is_prospect boolean not null default false;
alter table contacts add constraint contacts_kind_check check (is_customer or is_supplier or is_prospect);

create table crm_people (
  id bigserial primary key,
  contact_id bigint references contacts(id),
  first_name text not null check (length(first_name) between 1 and 100),
  last_name text check (last_name is null or length(last_name) between 1 and 100),
  job_title text check (job_title is null or length(job_title) between 1 and 100),
  email text check (email is null or length(email) between 3 and 254),
  phone text check (phone is null or length(phone) between 1 and 50),
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_people_contact_idx on crm_people (contact_id);
create index crm_people_email_idx on crm_people (lower(email));

create table crm_opportunities (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 200),
  contact_id bigint not null references contacts(id),
  point_of_contact_id bigint references crm_people(id),
  owner_user_id text,
  amount numeric(20, 2) not null default 0 check (amount >= 0),
  close_date date,
  stage text not null default 'new' check (stage in ('new', 'screening', 'meeting', 'proposal', 'won', 'lost')),
  position integer not null default 0,
  invoice_id bigint references sales_invoices(id),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (invoice_id is null or stage = 'won')
);
create index crm_opportunities_contact_idx on crm_opportunities (contact_id);
create unique index crm_opportunities_invoice_idx on crm_opportunities (invoice_id) where invoice_id is not null;

create table crm_tasks (
  id bigserial primary key,
  title text not null check (length(title) between 1 and 200),
  body text check (body is null or length(body) <= 4000),
  due_date date,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  assignee_user_id text,
  contact_id bigint references contacts(id),
  person_id bigint references crm_people(id),
  opportunity_id bigint references crm_opportunities(id),
  created_by_email text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_tasks_contact_idx on crm_tasks (contact_id);
create index crm_tasks_open_idx on crm_tasks (due_date) where status <> 'done';

create table crm_activities (
  id bigserial primary key,
  kind text not null check (kind in ('call', 'meeting', 'note')),
  happened_at timestamptz not null,
  subject text not null check (length(subject) between 1 and 200),
  body text check (body is null or length(body) <= 10000),
  contact_id bigint references contacts(id),
  person_id bigint references crm_people(id),
  opportunity_id bigint references crm_opportunities(id),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (contact_id is not null or person_id is not null or opportunity_id is not null)
);
create index crm_activities_contact_idx on crm_activities (contact_id);

-- People, opportunities, tasks and activities are never deleted.
create trigger crm_people_no_delete before delete on crm_people for each row execute function toeyee_forbid_delete();
create trigger crm_people_no_truncate before truncate on crm_people for each statement execute function toeyee_forbid_delete();
create trigger crm_opportunities_no_delete before delete on crm_opportunities for each row execute function toeyee_forbid_delete();
create trigger crm_opportunities_no_truncate before truncate on crm_opportunities for each statement execute function toeyee_forbid_delete();
create trigger crm_tasks_no_delete before delete on crm_tasks for each row execute function toeyee_forbid_delete();
create trigger crm_tasks_no_truncate before truncate on crm_tasks for each statement execute function toeyee_forbid_delete();
create trigger crm_activities_no_delete before delete on crm_activities for each row execute function toeyee_forbid_delete();
create trigger crm_activities_no_truncate before truncate on crm_activities for each statement execute function toeyee_forbid_delete();

-- Once an opportunity has made an invoice it stays won with that invoice.
create function tohyee_guard_crm_opportunity() returns trigger
language plpgsql as $$
begin
  if old.invoice_id is not null and (new.invoice_id is distinct from old.invoice_id or new.stage <> 'won') then
    raise exception 'This opportunity has made an invoice, so its stage can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger crm_opportunities_guard before update on crm_opportunities
  for each row execute function tohyee_guard_crm_opportunity();
`,
  };
