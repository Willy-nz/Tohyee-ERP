import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0030",
    name: "projects",
    sql: `
-- Projects and time tracking (examples PJ1-PJ12), like Xero Projects. A
-- project is work for one customer with tasks (hourly, fixed price or
-- non-chargeable), time entries in whole minutes, and expenses linked from
-- approved bill lines, expense claim receipts and spend money lines (linked,
-- never re-posted). Invoicing makes an ordinary draft sales invoice and links
-- each billed item to it, so nothing is billed twice; voiding the invoice or
-- deleting the draft makes the items unbilled again. Nothing here posts to the
-- ledger: only the invoices do.

-- Staff cost rates (admins): an hourly cost per member, copied onto each time
-- entry when it's entered. Never deleted (set to 0 instead).
create table project_staff_rates (
  user_id uuid primary key,
  cost_rate numeric not null check (cost_rate >= 0 and scale(cost_rate) <= 4),
  updated_by_email text,
  updated_at timestamptz not null default now()
);

create table projects (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  contact_id bigint not null references contacts(id),
  name text not null check (length(name) between 1 and 200),
  estimate numeric check (estimate is null or (estimate >= 0 and scale(estimate) <= 2)),
  deadline date,
  status text not null default 'in_progress' check (status in ('in_progress', 'closed')),
  closed_at timestamptz,
  closed_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((status = 'closed') = (closed_at is not null))
);
create index projects_contact_idx on projects (contact_id, id);

create table project_tasks (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  project_id bigint not null references projects(id),
  name text not null check (length(name) between 1 and 200),
  charge_type text not null check (charge_type in ('hourly', 'fixed', 'non_chargeable')),
  -- The hourly rate, or the fixed price; none for non-chargeable tasks.
  rate numeric check (rate is null or (rate > 0 and scale(rate) <= 4)),
  estimate_minutes integer check (estimate_minutes is null or estimate_minutes > 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  written_off_at timestamptz,
  written_off_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((charge_type = 'non_chargeable') = (rate is null)),
  check (charge_type <> 'fixed' or scale(rate) <= 2),
  check (written_off_at is null or charge_type = 'fixed')
);
create index project_tasks_project_idx on project_tasks (project_id, id);
create unique index project_tasks_name_idx on project_tasks (project_id, lower(name)) where status = 'active';

create table project_time_entries (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  project_id bigint not null references projects(id),
  task_id bigint not null references project_tasks(id),
  -- The member whose time it is (a user id in the core database).
  user_id uuid not null,
  user_email text not null check (length(user_email) between 1 and 320),
  entry_date date not null,
  minutes integer not null check (minutes between 1 and 1440),
  description text check (description is null or length(description) between 1 and 500),
  -- Their staff cost rate when the entry was made.
  cost_rate numeric not null default 0 check (cost_rate >= 0),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_at timestamptz,
  removed_by_email text,
  written_off_at timestamptz,
  written_off_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((status = 'removed') = (removed_at is not null))
);
create index project_time_entries_project_idx on project_time_entries (project_id, entry_date);
create index project_time_entries_user_idx on project_time_entries (user_id, entry_date);

create table project_expenses (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  project_id bigint not null references projects(id),
  source_type text not null check (source_type in ('bill_line', 'expense_claim_receipt', 'bank_transaction_line')),
  -- The line (no foreign keys, like fixed_assets.bill_line_id, so those
  -- tables keep their own truncate guards; the trigger below checks it).
  bill_line_id bigint,
  expense_claim_receipt_id bigint,
  bank_transaction_line_id bigint,
  -- The line's amount excluding GST.
  cost numeric not null check (cost > 0),
  chargeable boolean not null,
  markup_percent numeric not null default 0 check (markup_percent >= 0 and markup_percent <= 1000 and scale(markup_percent) <= 2),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_at timestamptz,
  removed_by_email text,
  written_off_at timestamptz,
  written_off_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (num_nonnulls(bill_line_id, expense_claim_receipt_id, bank_transaction_line_id) = 1),
  check ((source_type = 'bill_line') = (bill_line_id is not null)),
  check ((source_type = 'expense_claim_receipt') = (expense_claim_receipt_id is not null)),
  check ((source_type = 'bank_transaction_line') = (bank_transaction_line_id is not null)),
  check ((status = 'removed') = (removed_at is not null)),
  check (written_off_at is null or chargeable)
);
create index project_expenses_project_idx on project_expenses (project_id, id);
-- A line is on one project at a time (PJ4).
create unique index project_expenses_bill_line_idx on project_expenses (bill_line_id) where status = 'active';
create unique index project_expenses_receipt_idx on project_expenses (expense_claim_receipt_id) where status = 'active';
create unique index project_expenses_bank_line_idx on project_expenses (bank_transaction_line_id) where status = 'active';

-- An invoice made from a project (PJ6), and what it billed. Deleting the
-- draft invoice deletes these rows with it, so its items are unbilled again.
create table project_invoices (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  project_id bigint not null references projects(id),
  invoice_id bigint not null unique references sales_invoices(id) on delete cascade,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create index project_invoices_project_idx on project_invoices (project_id, id);

create table project_invoice_items (
  id bigserial primary key,
  project_invoice_id bigint not null references project_invoices(id) on delete cascade,
  project_id bigint not null references projects(id),
  kind text not null check (kind in ('time', 'fixed_task', 'expense')),
  time_entry_id bigint references project_time_entries(id),
  task_id bigint references project_tasks(id),
  expense_id bigint references project_expenses(id),
  line_order integer not null check (line_order > 0),
  check (num_nonnulls(time_entry_id, task_id, expense_id) = 1),
  check ((kind = 'time') = (time_entry_id is not null)),
  check ((kind = 'fixed_task') = (task_id is not null)),
  check ((kind = 'expense') = (expense_id is not null))
);
create index project_invoice_items_invoice_idx on project_invoice_items (project_invoice_id);
create index project_invoice_items_time_idx on project_invoice_items (time_entry_id) where time_entry_id is not null;
create index project_invoice_items_task_idx on project_invoice_items (task_id) where task_id is not null;
create index project_invoice_items_expense_idx on project_invoice_items (expense_id) where expense_id is not null;

-- The invoice an item is billed on: one that isn't voided (drafts count).
create function tohyee_project_item_invoice(p_kind text, p_id bigint) returns bigint
language sql stable as $$
  select s.id
    from project_invoice_items i
    join project_invoices pi on pi.id = i.project_invoice_id
    join sales_invoices s on s.id = pi.invoice_id
   where s.status <> 'voided'
     and case p_kind when 'time' then i.time_entry_id = p_id
                     when 'fixed_task' then i.task_id = p_id
                     else i.expense_id = p_id end
   order by s.id
   limit 1
$$;

-- Whether anything of a task has been invoiced (its time, or itself).
create function tohyee_project_task_billed(p_task bigint) returns boolean
language sql stable as $$
  select tohyee_project_item_invoice('fixed_task', p_task) is not null
      or exists (select 1 from project_time_entries e
                  where e.task_id = p_task and tohyee_project_item_invoice('time', e.id) is not null)
$$;

-- What stops a project closing: a draft project invoice, or something
-- unbilled that hasn't been written off (PJ10). Null when nothing does.
create function tohyee_project_open_item(p_project bigint) returns text
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
        and tohyee_project_item_invoice('expense', x.id) is null limit 1))
$$;

create function tohyee_require_open_project(p_project bigint) returns void
language plpgsql as $$
declare
  project record;
begin
  select name, status into project from projects where id = p_project;
  if project.status = 'closed' then
    raise exception 'Project % is closed. Reopen it first', project.name using errcode = 'P0001';
  end if;
end;
$$;

create function tohyee_guard_project_staff_rate() returns trigger
language plpgsql as $$
begin
  raise exception 'Staff cost rates can''t be deleted; set the rate to 0 instead' using errcode = 'P0001';
end;
$$;
create trigger project_staff_rates_guard before delete on project_staff_rates
  for each row execute function tohyee_guard_project_staff_rate();
create trigger project_staff_rates_no_truncate before truncate on project_staff_rates
  for each statement execute function tohyee_guard_project_staff_rate();

-- Projects are never deleted. Only Close and Reopen change the status;
-- closing needs nothing unbilled and no draft invoices; a closed project
-- doesn't change otherwise; the customer only changes before any invoice.
create function tohyee_guard_project() returns trigger
language plpgsql as $$
declare
  blocking text;
  fixed text[] := array['status', 'closed_at', 'closed_by_email', 'updated_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'projects can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Projects can''t be deleted; close them instead' using errcode = 'P0001';
  end if;
  if new.status <> old.status and (to_jsonb(new) - fixed) <> (to_jsonb(old) - fixed) then
    raise exception 'Closing or reopening a project changes nothing else' using errcode = 'P0001';
  end if;
  if old.status = 'in_progress' and new.status = 'closed' then
    blocking := tohyee_project_open_item(old.id);
    if blocking is not null then
      raise exception 'Project % can''t be closed: %', old.name, blocking using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status = 'closed' and new.status = 'closed' then
    raise exception 'Project % is closed. Reopen it first', old.name using errcode = 'P0001';
  end if;
  if new.contact_id <> old.contact_id and exists (select 1 from project_invoices where project_id = old.id) then
    raise exception 'Project % has invoices, so its customer can''t change', old.name using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger projects_guard before update or delete on projects
  for each row execute function tohyee_guard_project();
create trigger projects_no_truncate before truncate on projects
  for each statement execute function tohyee_guard_project();

-- Tasks are archived, never deleted. The charge type, and a fixed price,
-- don't change once something of the task is invoiced; a write-off is only
-- of an unbilled fixed price and is never undone.
create function tohyee_guard_project_task() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'project_tasks can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Project tasks can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    perform tohyee_require_open_project(new.project_id);
    if new.written_off_at is not null or new.status <> 'active' then
      raise exception 'A task starts active and not written off' using errcode = 'P0001';
    end if;
    return new;
  end if;
  perform tohyee_require_open_project(old.project_id);
  if new.project_id <> old.project_id then
    raise exception 'A task stays on its project' using errcode = 'P0001';
  end if;
  if old.written_off_at is not null and new.written_off_at is distinct from old.written_off_at then
    raise exception 'Task % has been written off, and that can''t be undone', old.name using errcode = 'P0001';
  end if;
  if (new.charge_type <> old.charge_type or (old.charge_type = 'fixed' and new.rate <> old.rate))
     and tohyee_project_task_billed(old.id) then
    raise exception 'Task % has been invoiced, so its charge type and fixed price can''t change', old.name using errcode = 'P0001';
  end if;
  if old.written_off_at is null and new.written_off_at is not null
     and tohyee_project_item_invoice('fixed_task', old.id) is not null then
    raise exception 'Task % has been invoiced, so it can''t be written off', old.name using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger project_tasks_guard before insert or update or delete on project_tasks
  for each row execute function tohyee_guard_project_task();
create trigger project_tasks_no_truncate before truncate on project_tasks
  for each statement execute function tohyee_guard_project_task();

-- Time entries are removed, never deleted. They change only while their
-- project is open and they aren't invoiced, removed or written off; a new
-- entry is on an active task of its project (PJ3, PJ8).
create function tohyee_guard_project_time_entry() returns trigger
language plpgsql as $$
declare
  task record;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'project_time_entries can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Time entries can''t be deleted; remove them instead' using errcode = 'P0001';
  end if;
  perform tohyee_require_open_project(new.project_id);
  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id then
      raise exception 'A time entry stays on its project' using errcode = 'P0001';
    end if;
    if old.status = 'removed' then
      raise exception 'This time entry has been removed' using errcode = 'P0001';
    end if;
    if old.written_off_at is not null then
      raise exception 'This time entry has been written off and can''t change' using errcode = 'P0001';
    end if;
    if tohyee_project_item_invoice('time', old.id) is not null then
      raise exception 'This time entry is on an invoice, so it can''t change. Void or delete the invoice first' using errcode = 'P0001';
    end if;
  elsif new.status <> 'active' or new.written_off_at is not null then
    raise exception 'A time entry starts active and not written off' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' or new.task_id <> old.task_id then
    select project_id, status, name into task from project_tasks where id = new.task_id;
    if task.project_id <> new.project_id then
      raise exception 'The task isn''t on this project' using errcode = 'P0001';
    end if;
    if task.status <> 'active' then
      raise exception 'Task % is archived, so no more time can go on it', task.name using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger project_time_entries_guard before insert or update or delete on project_time_entries
  for each row execute function tohyee_guard_project_time_entry();
create trigger project_time_entries_no_truncate before truncate on project_time_entries
  for each statement execute function tohyee_guard_project_time_entry();

-- A linked expense is an approved bill's line, an approved expense claim's
-- receipt or a posted spend money line, at its amount excluding GST (PJ4).
-- Links are removed, never deleted, and change only while their project is
-- open and they aren't invoiced, removed or written off.
create function tohyee_guard_project_expense() returns trigger
language plpgsql as $$
declare
  source record;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'project_expenses can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Project expenses can''t be deleted; remove them from the project instead' using errcode = 'P0001';
  end if;
  perform tohyee_require_open_project(new.project_id);
  if tg_op = 'INSERT' then
    if new.status <> 'active' or new.written_off_at is not null then
      raise exception 'A project expense starts active and not written off' using errcode = 'P0001';
    end if;
    if new.bill_line_id is not null then
      select b.status = 'approved' as ok, l.net_amount into source
        from bill_lines l join bills b on b.id = l.bill_id where l.id = new.bill_line_id;
    elsif new.expense_claim_receipt_id is not null then
      select c.status = 'approved' as ok, r.net_amount into source
        from expense_claim_receipts r join expense_claims c on c.id = r.claim_id where r.id = new.expense_claim_receipt_id;
    else
      select t.status = 'posted' and t.kind = 'spend' as ok, l.net_amount into source
        from bank_transaction_lines l join bank_transactions t on t.id = l.bank_transaction_id where l.id = new.bank_transaction_line_id;
    end if;
    if source.ok is not true then
      raise exception 'Only lines of approved bills, approved expense claims and spend money can go on a project' using errcode = 'P0001';
    end if;
    if new.cost <> source.net_amount then
      raise exception 'A project expense costs its line''s amount excluding GST (%)', source.net_amount using errcode = 'P0001';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['chargeable', 'markup_percent', 'status', 'removed_at', 'removed_by_email',
                            'written_off_at', 'written_off_by_email', 'updated_at'])
     <> (to_jsonb(old) - array['chargeable', 'markup_percent', 'status', 'removed_at', 'removed_by_email',
                               'written_off_at', 'written_off_by_email', 'updated_at']) then
    raise exception 'A project expense''s line, project and cost never change' using errcode = 'P0001';
  end if;
  if old.status = 'removed' then
    raise exception 'This expense has been removed from its project' using errcode = 'P0001';
  end if;
  if old.written_off_at is not null then
    raise exception 'This expense has been written off and can''t change' using errcode = 'P0001';
  end if;
  if tohyee_project_item_invoice('expense', old.id) is not null then
    raise exception 'This expense is on an invoice, so it can''t change. Void or delete the invoice first' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger project_expenses_guard before insert or update or delete on project_expenses
  for each row execute function tohyee_guard_project_expense();
create trigger project_expenses_no_truncate before truncate on project_expenses
  for each statement execute function tohyee_guard_project_expense();

-- Project invoices and their items are only ever added, and go only with
-- the draft invoice they belong to when it's deleted.
create function tohyee_guard_project_invoice() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated', tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'What a project invoice billed never changes; void or delete the invoice instead' using errcode = 'P0001';
  end if;
  if tg_table_name = 'project_invoices' then
    if exists (select 1 from sales_invoices where id = old.invoice_id) then
      raise exception 'A project invoice goes only when its draft invoice is deleted' using errcode = 'P0001';
    end if;
  elsif exists (select 1 from project_invoices where id = old.project_invoice_id) then
    raise exception 'A project invoice goes only when its draft invoice is deleted' using errcode = 'P0001';
  end if;
  return old;
end;
$$;
create trigger project_invoices_guard before update or delete on project_invoices
  for each row execute function tohyee_guard_project_invoice();
create trigger project_invoices_no_truncate before truncate on project_invoices
  for each statement execute function tohyee_guard_project_invoice();
create trigger project_invoice_items_guard before update or delete on project_invoice_items
  for each row execute function tohyee_guard_project_invoice();
create trigger project_invoice_items_no_truncate before truncate on project_invoice_items
  for each statement execute function tohyee_guard_project_invoice();

create function tohyee_check_project_invoice() returns trigger
language plpgsql as $$
begin
  perform tohyee_require_open_project(new.project_id);
  return new;
end;
$$;
create trigger project_invoices_check before insert on project_invoices
  for each row execute function tohyee_check_project_invoice();

-- An item billed is unbilled, chargeable, of the invoice's project, and on
-- no other invoice that isn't voided (PJ6). Checked after the insert, so
-- two rows of one statement for the same item are caught too.
create function tohyee_check_project_invoice_item() returns trigger
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
     and coalesce(i.time_entry_id, i.task_id, i.expense_id) = coalesce(new.time_entry_id, new.task_id, new.expense_id);
  if billed > 1 then
    raise exception 'That is already on an invoice' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger project_invoice_items_check after insert on project_invoice_items
  for each row execute function tohyee_check_project_invoice_item();

-- A closed project has nothing unbilled, so its invoices can't be voided or
-- deleted until it's reopened (PJ10).
create function tohyee_check_project_invoice_change() returns trigger
language plpgsql as $$
declare
  project text;
begin
  if tg_op = 'DELETE' or (new.status = 'voided' and old.status <> 'voided') then
    select p.name into project from project_invoices pi join projects p on p.id = pi.project_id
     where pi.invoice_id = old.id and p.status = 'closed';
    if project is not null then
      raise exception 'This invoice is from project %, which is closed. Reopen the project first', project using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger sales_invoices_projects before update or delete on sales_invoices
  for each row execute function tohyee_check_project_invoice_change();

-- A bill, expense claim or spend money can't be voided while one of its
-- lines is on a project (PJ4): the project would keep a cost the ledger no
-- longer has. Remove it from the project first.
create function tohyee_check_project_expense_source() returns trigger
language plpgsql as $$
declare
  project text;
begin
  if new.status = 'voided' and old.status <> 'voided' then
    if tg_table_name = 'bills' then
      select p.name into project from project_expenses x join bill_lines l on l.id = x.bill_line_id join projects p on p.id = x.project_id
       where l.bill_id = new.id and x.status = 'active' limit 1;
    elsif tg_table_name = 'expense_claims' then
      select p.name into project from project_expenses x join expense_claim_receipts r on r.id = x.expense_claim_receipt_id
        join projects p on p.id = x.project_id
       where r.claim_id = new.id and x.status = 'active' limit 1;
    else
      select p.name into project from project_expenses x join bank_transaction_lines l on l.id = x.bank_transaction_line_id
        join projects p on p.id = x.project_id
       where l.bank_transaction_id = new.id and x.status = 'active' limit 1;
    end if;
    if project is not null then
      raise exception 'A line of this is on project %, so it can''t be voided. Remove it from the project first', project
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger bills_projects before update on bills
  for each row execute function tohyee_check_project_expense_source();
create trigger expense_claims_projects before update on expense_claims
  for each row execute function tohyee_check_project_expense_source();
create trigger bank_transactions_projects before update on bank_transactions
  for each row execute function tohyee_check_project_expense_source();
`,
  };
