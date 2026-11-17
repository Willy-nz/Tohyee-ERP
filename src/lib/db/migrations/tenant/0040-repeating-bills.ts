import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0040",
    name: "repeating_bills",
    sql: `
-- Repeating bill templates (RB1-RB10), the purchases twin of repeating
-- invoices (RI1-RI10) and like Xero's repeating bills. The same schedule
-- (every N weeks or months from the start date, until an optional end date);
-- templates are ended, never deleted, and post nothing.
--
-- Suppliers have no payment terms in Tohyee, so the due date is a rule:
-- N days after the bill date, N days after the end of the bill's month, or
-- day N of the following month. Every bill needs a supplier invoice number
-- that's unique for its supplier, so the template holds a pattern with
-- {date} or {n} (RB3), filled in for each bill.
create table repeating_bills (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  contact_id bigint not null references contacts(id),
  supplier_invoice_number text not null check (length(supplier_invoice_number) between 1 and 80
    and (supplier_invoice_number like '%{date}%' or supplier_invoice_number like '%{n}%' or supplier_invoice_number like '%{month}%')),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  custom_fields jsonb not null default '{}'::jsonb,
  period text not null check (period in ('week', 'month')),
  every integer not null check (every between 1 and 99),
  start_date date not null,
  end_date date,
  due_rule text not null check (due_rule in ('days_after', 'days_after_month_end', 'day_of_next_month')),
  due_days integer not null check (due_days between 0 and 365),
  save_as text not null check (save_as in ('draft', 'approve')),
  resumed_from date,
  last_error text,
  last_error_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (end_date is null or end_date >= start_date),
  check (due_rule <> 'day_of_next_month' or due_days between 1 and 31),
  check (total = subtotal + tax_total)
);
create index repeating_bills_status_idx on repeating_bills (status, id);
create trigger repeating_bills_no_delete before delete on repeating_bills
  for each row execute function toeyee_forbid_delete();
create trigger repeating_bills_no_truncate before truncate on repeating_bills
  for each statement execute function toeyee_forbid_delete();

-- An ended template can't change or start again (RB8).
create function tohyee_guard_repeating_bill() returns trigger
language plpgsql as $$
begin
  if old.status = 'ended' then
    raise exception 'This repeating bill has ended, so it can''t be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger repeating_bills_guard before update on repeating_bills
  for each row execute function tohyee_guard_repeating_bill();

create table repeating_bill_lines (
  id bigserial primary key,
  repeating_bill_id bigint not null references repeating_bills(id),
  line_order integer not null check (line_order > 0),
  description text not null check (length(description) between 1 and 500),
  quantity numeric not null check (quantity > 0 and scale(quantity) <= 4),
  unit_price numeric not null check (unit_price > 0 and scale(unit_price) <= 4),
  account_id bigint not null references accounts(id),
  tax_code_id bigint references tax_codes(id),
  tax_rate numeric not null default 0 check (tax_rate >= 0 and tax_rate <= 1),
  line_amount numeric not null check (line_amount > 0),
  net_amount numeric not null check (net_amount >= 0),
  tax_amount numeric not null check (tax_amount >= 0),
  tracking jsonb not null default '{}'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  item_id bigint references items(id),
  unit_id bigint references item_units(id),
  base_quantity numeric,
  unique (repeating_bill_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount),
  check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null))
);
create function tohyee_guard_repeating_bill_line() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'repeating_bill_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if (select status from repeating_bills
       where id = case when tg_op = 'DELETE' then old.repeating_bill_id else new.repeating_bill_id end) = 'ended' then
    raise exception 'Lines of an ended repeating bill can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger repeating_bill_lines_guard before insert or update or delete on repeating_bill_lines
  for each row execute function tohyee_guard_repeating_bill_line();
create trigger repeating_bill_lines_no_truncate before truncate on repeating_bill_lines
  for each statement execute function tohyee_guard_repeating_bill_line();
create trigger repeating_bill_lines_item before insert or update on repeating_bill_lines
  for each row execute function tohyee_check_line_item();
create trigger repeating_bill_lines_tracking before insert or update on repeating_bill_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger repeating_bills_custom_fields before insert or update on repeating_bills
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger repeating_bill_lines_custom_fields before insert or update on repeating_bill_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');

-- One row per scheduled date that made a bill: the unique key stops a date
-- being made twice (RB4). Never changed or deleted, except that deleting the
-- draft bill clears its link (RB9), so the date isn't made again.
create table repeating_bill_runs (
  id bigserial primary key,
  repeating_bill_id bigint not null references repeating_bills(id),
  scheduled_date date not null,
  bill_id bigint unique references bills(id) on delete set null,
  bill_deleted boolean not null default false,
  outcome text not null check (outcome in ('draft', 'approved', 'approval_refused')),
  message text check (message is null or length(message) between 1 and 1000),
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (repeating_bill_id, scheduled_date),
  check (outcome <> 'approval_refused' or message is not null),
  check (outcome <> 'draft' or message is null)
);
create function tohyee_guard_repeating_bill_run() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'repeating_bill_runs can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A repeating bill''s history can''t be deleted' using errcode = 'P0001';
  end if;
  if old.bill_id is not null and new.bill_id is null
     and (to_jsonb(new) - array['bill_id', 'bill_deleted']) = (to_jsonb(old) - array['bill_id', 'bill_deleted']) then
    new.bill_deleted := true;
    return new;
  end if;
  raise exception 'A repeating bill''s history can''t be changed' using errcode = 'P0001';
end;
$$;
create trigger repeating_bill_runs_guard before update or delete on repeating_bill_runs
  for each row execute function tohyee_guard_repeating_bill_run();
create trigger repeating_bill_runs_no_truncate before truncate on repeating_bill_runs
  for each statement execute function tohyee_guard_repeating_bill_run();
`,
  };
