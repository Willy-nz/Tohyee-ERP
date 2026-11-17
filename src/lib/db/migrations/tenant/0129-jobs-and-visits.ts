import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0129",
    name: "jobs_and_visits",
    sql: `
-- Jobs and visits inside Projects (examples JV1-JV9, approved by Jess 8 and
-- 12 Oct 2026, decision 510; ServiceM8 and Tradify). A job is a project with
-- a site; its visits are on a calendar for Tohyee users; Start and Finish
-- fill in hours the staff member confirms into project time; materials go
-- out of stock when the job is invoiced, as the add-ons do.
alter table projects
  add column is_job boolean not null default false,
  add column site_address text check (site_address is null or length(site_address) between 1 and 500),
  add column site_contact text check (site_contact is null or length(site_contact) between 1 and 200),
  add column service_interval_months integer check (service_interval_months is null or service_interval_months between 1 and 120),
  add column checklist_items jsonb not null default '[]'::jsonb;

create table project_visits (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  project_id bigint not null references projects(id),
  task_id bigint not null references project_tasks(id),
  user_id uuid not null,
  user_email text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  notes text check (notes is null or length(notes) <= 1000),
  status text not null default 'scheduled' check (status in ('scheduled', 'started', 'finished', 'cancelled')),
  started_at timestamptz,
  finished_at timestamptz,
  finished_with_open_checks boolean not null default false,
  signed_by text check (signed_by is null or length(signed_by) between 1 and 200),
  signed_at timestamptz,
  time_entry_id bigint references project_time_entries(id),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (ends_at > starts_at),
  check ((status in ('started', 'finished')) = (started_at is not null)),
  check ((status = 'finished') = (finished_at is not null))
);
create index project_visits_user_time on project_visits (user_id, starts_at) where status <> 'cancelled';
create index project_visits_project on project_visits (project_id, starts_at);

-- Who ticked each checklist item on a visit, and when (JV5).
create table project_visit_checks (
  visit_id bigint not null references project_visits(id),
  item text not null,
  ticked_by_email text not null,
  ticked_at timestamptz not null default now(),
  primary key (visit_id, item)
);

-- Materials used on a job (JV4): billed on the project invoice, where the item's stock goes out.
create table project_materials (
  id bigserial primary key,
  project_id bigint not null references projects(id),
  visit_id bigint references project_visits(id),
  item_id bigint not null references items(id),
  quantity numeric not null check (quantity > 0 and scale(quantity) <= 4),
  unit_price numeric not null check (unit_price >= 0 and scale(unit_price) <= 4),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text not null,
  created_at timestamptz not null default now()
);

alter table project_invoice_items add column material_id bigint references project_materials(id);
alter table project_invoice_items drop constraint project_invoice_items_kind_check;
alter table project_invoice_items add constraint project_invoice_items_kind_check check (kind in ('time', 'fixed_task', 'expense', 'material'));
alter table project_invoice_items drop constraint project_invoice_items_check;
alter table project_invoice_items add constraint project_invoice_items_check check (num_nonnulls(time_entry_id, task_id, expense_id, material_id) = 1);
alter table project_invoice_items add check ((kind = 'material') = (material_id is not null));

create or replace function tohyee_check_project_invoice_item() returns trigger
language plpgsql as $$
declare
  v_project bigint;
  item record;
  billed integer;
begin
  select pi.project_id into v_project from project_invoices pi where pi.id = new.project_invoice_id;
  if v_project <> new.project_id then
    raise exception 'A project invoice bills only its own project' using errcode = 'P0001';
  end if;
  perform tohyee_require_open_project(new.project_id);
  if new.kind = 'time' then
    select e.project_id, e.status = 'active' and e.written_off_at is null and t.charge_type = 'hourly' as ok into item
      from project_time_entries e join project_tasks t on t.id = e.task_id where e.id = new.time_entry_id;
  elsif new.kind = 'fixed_task' then
    select t.project_id, t.status = 'active' and t.written_off_at is null and t.charge_type = 'fixed' as ok into item
      from project_tasks t where t.id = new.task_id;
  elsif new.kind = 'material' then
    select m.project_id, m.status = 'active' as ok into item
      from project_materials m where m.id = new.material_id;
  else
    select x.project_id, x.status = 'active' and x.written_off_at is null and x.chargeable as ok into item
      from project_expenses x where x.id = new.expense_id;
  end if;
  if item.project_id is distinct from new.project_id then
    raise exception 'A project invoice bills only its own project' using errcode = 'P0001';
  end if;
  if item.ok is not true then
    raise exception 'Only unbilled time on hourly tasks, fixed prices and chargeable expenses can be invoiced' using errcode = 'P0001';
  end if;
  select count(*) into billed
    from project_invoice_items i
    join project_invoices pi on pi.id = i.project_invoice_id
    join sales_invoices s on s.id = pi.invoice_id
   where s.status <> 'voided'
     and i.kind = new.kind
     and coalesce(i.time_entry_id, i.task_id, i.expense_id, i.material_id) = coalesce(new.time_entry_id, new.task_id, new.expense_id, new.material_id);
  if billed > 1 then
    raise exception 'That is already on an invoice' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function tohyee_project_item_invoice(p_kind text, p_id bigint) returns bigint
language sql stable as $$
  select s.id
    from project_invoice_items i
    join project_invoices pi on pi.id = i.project_invoice_id
    join sales_invoices s on s.id = pi.invoice_id
   where s.status <> 'voided'
     and case p_kind when 'time' then i.time_entry_id = p_id
                     when 'fixed_task' then i.task_id = p_id
                     when 'material' then i.material_id = p_id
                     else i.expense_id = p_id end
   order by s.id
   limit 1
$$;

-- Unbilled materials also stop a job closing (closing with "write off"
-- takes them off the job instead: their stock never went out).
create or replace function tohyee_project_open_item(p_project bigint) returns text
language sql stable as $$
  select coalesce(
    (select 'a project invoice is still a draft (approve or delete it)'
       from project_invoices pi join sales_invoices s on s.id = pi.invoice_id
      where pi.project_id = p_project and s.status = 'draft' limit 1),
    (select 'time on ' || t.name || ' is unbilled'
       from project_time_entries e join project_tasks t on t.id = e.task_id
      where e.project_id = p_project and e.status = 'active' and e.written_off_at is null
        and t.charge_type = 'hourly' and tohyee_project_item_invoice('time', e.id) is null limit 1),
    (select 'the fixed price of ' || t.name || ' is unbilled'
       from project_tasks t
      where t.project_id = p_project and t.status = 'active' and t.charge_type = 'fixed'
        and t.written_off_at is null and tohyee_project_item_invoice('fixed_task', t.id) is null limit 1),
    (select 'a chargeable expense is unbilled'
       from project_expenses x
      where x.project_id = p_project and x.status = 'active' and x.chargeable and x.written_off_at is null
        and tohyee_project_item_invoice('expense', x.id) is null limit 1),
    (select 'materials are unbilled'
       from project_materials m
      where m.project_id = p_project and m.status = 'active'
        and tohyee_project_item_invoice('material', m.id) is null limit 1))
$$;

alter table record_notes drop constraint record_notes_record_type_check;
alter table record_notes add constraint record_notes_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset', 'livestock_election', 'project_visit'));
alter table record_attachments drop constraint record_attachments_record_type_check;
alter table record_attachments add constraint record_attachments_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset', 'livestock_election', 'project_visit'));
`,
  };
