import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0055",
    name: "sales_orders",
    sql: `
-- Sales orders, stage 1 (examples SO1-SO12), following NetSuite's. A draft can
-- be edited and deleted; approving numbers it (SO-0001, no gaps) and locks
-- it. Sales orders post nothing and don't touch stock. "Invoice" makes a
-- draft invoice whose lines point back to the order's lines; what's invoiced
-- is worked out from those invoices, never stored. An approved order can be
-- closed (nothing more to invoice) or cancelled (only with no invoices that
-- aren't voided).

create table sales_order_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into sales_order_numbering (id) values (true);
create trigger sales_order_numbering_guard
  before update or delete on sales_order_numbering
  for each row execute function toeyee_guard_invoice_numbering();
create trigger sales_order_numbering_no_truncate
  before truncate on sales_order_numbering
  for each statement execute function toeyee_guard_invoice_numbering();

create table sales_orders (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'closed', 'cancelled')),
  contact_id bigint not null references contacts(id),
  order_date date not null,
  expected_date date,
  reference text check (reference is null or length(reference) between 1 and 100),
  memo text check (memo is null or length(memo) between 1 and 1000),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  custom_fields jsonb not null default '{}'::jsonb,
  salesperson_id bigint references salespeople(id),
  so_sequence integer unique check (so_sequence > 0),
  so_number text unique,
  approve_command_source text,
  approve_idempotency_key text,
  approve_request_hash text,
  approved_by_user_id uuid,
  approved_by_email text,
  approved_at timestamptz,
  close_command_source text,
  close_idempotency_key text,
  close_request_hash text,
  closed_by_user_id uuid,
  closed_by_email text,
  closed_at timestamptz,
  cancel_command_source text,
  cancel_idempotency_key text,
  cancel_request_hash text,
  cancelled_by_user_id uuid,
  cancelled_by_email text,
  cancelled_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (close_command_source, close_idempotency_key),
  unique (cancel_command_source, cancel_idempotency_key),
  check (expected_date is null or expected_date >= order_date),
  check (total = subtotal + tax_total),
  check (so_number is null or so_number = 'SO-' || lpad(so_sequence::text, greatest(4, length(so_sequence::text)), '0')),
  check ((status = 'draft') = (so_number is null)),
  check ((status = 'draft') = (approved_at is null)),
  check ((status = 'closed') = (closed_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index sales_orders_status_idx on sales_orders (status, id);
create index sales_orders_contact_idx on sales_orders (contact_id);

create table sales_order_lines (
  id bigserial primary key,
  sales_order_id bigint not null references sales_orders(id),
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
  unique (sales_order_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount),
  check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null))
);

-- A draft can be edited and deleted. An approved sales order is locked: it
-- can only be closed (not while it has draft invoices) or cancelled (only
-- while it has no invoices that aren't voided), once (SO2, SO7, SO8). Its
-- lines are frozen with it.
create function tohyee_guard_sales_order() returns trigger
language plpgsql as $$
declare
  close_columns text[] := array['status', 'close_command_source', 'close_idempotency_key', 'close_request_hash',
    'closed_by_user_id', 'closed_by_email', 'closed_at', 'updated_at'];
  cancel_columns text[] := array['status', 'cancel_command_source', 'cancel_idempotency_key', 'cancel_request_hash',
    'cancelled_by_user_id', 'cancelled_by_email', 'cancelled_at', 'updated_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_orders can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.status in ('closed', 'cancelled') then
      raise exception 'A draft sales order can''t be closed or cancelled; delete it instead' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Sales order % is %, so it can''t be deleted', old.so_number, old.status using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'closed'
     and (to_jsonb(new) - close_columns) = (to_jsonb(old) - close_columns) then
    if exists (select 1 from sales_invoices where sales_order_id = old.id and status = 'draft') then
      raise exception 'Sales order % has draft invoices, so it can''t be closed', old.so_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status = 'approved' and new.status = 'cancelled'
     and (to_jsonb(new) - cancel_columns) = (to_jsonb(old) - cancel_columns) then
    if exists (select 1 from sales_invoices where sales_order_id = old.id and status <> 'voided') then
      raise exception 'Sales order % has invoices, so it can''t be cancelled', old.so_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Sales order % is %, so it can''t be changed', old.so_number, old.status using errcode = 'P0001';
end;
$$;
create trigger sales_orders_guard before update or delete on sales_orders
  for each row execute function tohyee_guard_sales_order();
create trigger sales_orders_no_truncate before truncate on sales_orders
  for each statement execute function tohyee_guard_sales_order();

create function tohyee_guard_sales_order_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_order_lines can''t be truncated' using errcode = 'P0001';
  end if;
  select status into parent_status from sales_orders
   where id = case when tg_op = 'DELETE' then old.sales_order_id else new.sales_order_id end for share;
  if parent_status <> 'draft' then
    raise exception 'Lines of an approved sales order can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.sales_order_id <> new.sales_order_id then
    raise exception 'A sales order line can''t move to another sales order' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger sales_order_lines_guard before insert or update or delete on sales_order_lines
  for each row execute function tohyee_guard_sales_order_line();
create trigger sales_order_lines_no_truncate before truncate on sales_order_lines
  for each statement execute function tohyee_guard_sales_order_line();
create trigger sales_order_lines_item before insert or update on sales_order_lines
  for each row execute function tohyee_check_line_item();
create trigger sales_order_lines_tracking before insert or update on sales_order_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger sales_orders_custom_fields before insert or update on sales_orders
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger sales_order_lines_custom_fields before insert or update on sales_order_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');

-- In the customer's currency, like quotes (MC25), with no rate; a contact's
-- currency can't change once it has sales orders.
create trigger sales_orders_currency_check before insert or update of contact_id, currency_code on sales_orders
  for each row execute function tohyee_check_contact_currency();
create function tohyee_guard_contact_currency_sales_orders() returns trigger
language plpgsql as $$
begin
  if coalesce(new.currency_code, '') is distinct from coalesce(old.currency_code, '')
     and exists (select 1 from sales_orders where contact_id = old.id) then
    raise exception 'Contact % has sales orders, so its currency can''t change', old.name using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger contacts_currency_sales_orders_guard
  before update of currency_code on contacts
  for each row execute function tohyee_guard_contact_currency_sales_orders();

-- Invoices made from a sales order (SO3-SO6). The invoice names it, and each
-- of its lines that came from it names that line.
alter table sales_invoices add column sales_order_id bigint references sales_orders(id);
create index sales_invoices_sales_order_idx on sales_invoices (sales_order_id) where sales_order_id is not null;
alter table sales_invoice_lines add column sales_order_line_id bigint references sales_order_lines(id);
create index sales_invoice_lines_sales_order_line_idx on sales_invoice_lines (sales_order_line_id) where sales_order_line_id is not null;

-- An invoice's sales order was approved when the invoice was made, is for
-- the same customer, and can't be changed once set. Voiding an invoice of a
-- closed order is still allowed (SO7).
create function tohyee_check_invoice_sales_order() returns trigger
language plpgsql as $$
declare
  so record;
begin
  if tg_op = 'UPDATE' and new.sales_order_id is distinct from old.sales_order_id then
    raise exception 'An invoice''s sales order can''t be changed' using errcode = 'P0001';
  end if;
  if new.sales_order_id is null then
    return new;
  end if;
  select status, contact_id into so from sales_orders where id = new.sales_order_id;
  if tg_op = 'INSERT' and so.status <> 'approved' then
    raise exception 'Invoices can only be made from an approved sales order' using errcode = 'P0001';
  end if;
  if so.contact_id <> new.contact_id then
    raise exception 'An invoice from a sales order must be to the sales order''s customer' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger sales_invoices_sales_order before insert or update of contact_id, sales_order_id on sales_invoices
  for each row execute function tohyee_check_invoice_sales_order();

-- An invoice line from a sales order line: that line is on the invoice's own
-- sales order, which is approved, it has the same item and unit, and the
-- invoices that aren't voided never add up to more than was ordered (SO6).
-- The order is locked for update, so two transactions adding to the same
-- order take turns and the second counts the first's lines once it commits;
-- closing or cancelling it waits too.
create function tohyee_check_invoice_line_sales_order() returns trigger
language plpgsql as $$
declare
  so_line record;
  invoice_so bigint;
  so_status text;
  on_invoices numeric;
begin
  if new.sales_order_line_id is null then
    return new;
  end if;
  select sales_order_id, quantity, item_id, unit_id into so_line from sales_order_lines where id = new.sales_order_line_id;
  select sales_order_id into invoice_so from sales_invoices where id = new.invoice_id;
  if invoice_so is distinct from so_line.sales_order_id then
    raise exception 'An invoice line can only come from its own invoice''s sales order' using errcode = 'P0001';
  end if;
  select status into so_status from sales_orders where id = so_line.sales_order_id for update;
  if so_status <> 'approved' then
    raise exception 'Invoice lines can only come from an approved sales order' using errcode = 'P0001';
  end if;
  if new.item_id is distinct from so_line.item_id or new.unit_id is distinct from so_line.unit_id then
    raise exception 'An invoice line from a sales order keeps its item and unit' using errcode = 'P0001';
  end if;
  select coalesce(sum(l.quantity), 0) into on_invoices
    from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id
   where l.sales_order_line_id = new.sales_order_line_id and i.status <> 'voided';
  if on_invoices > so_line.quantity then
    raise exception 'Invoices can''t add up to more than the sales order line ordered' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger sales_invoice_lines_sales_order
  after insert or update of sales_order_line_id, quantity, item_id, unit_id, invoice_id on sales_invoice_lines
  for each row execute function tohyee_check_invoice_line_sales_order();

-- A finalised quote can be accepted as a sales order instead of an invoice
-- (SO9; NetSuite's estimate to sales order). An accepted quote has one or
-- the other, never both.
alter table quotes add column sales_order_id bigint unique references sales_orders(id);
do $do$
declare
  found text;
begin
  select conname into found from pg_constraint
   where conrelid = 'quotes'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%status = ''accepted''%invoice_id IS NOT NULL%';
  if found is null then
    raise exception 'quotes'' accepted check wasn''t found';
  end if;
  execute format('alter table quotes drop constraint %I', found);
end;
$do$;
alter table quotes add constraint quotes_accepted_check
  check ((status = 'accepted') = (invoice_id is not null or sales_order_id is not null)
         and (invoice_id is null or sales_order_id is null));

create or replace function tohyee_guard_quote() returns trigger
language plpgsql as $$
declare
  close_columns text[] := array['status', 'invoice_id', 'sales_order_id', 'close_command_source', 'close_idempotency_key',
    'close_request_hash', 'closed_by_user_id', 'closed_by_email', 'closed_at', 'updated_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'quotes can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Quote % is %, so it can''t be deleted', old.quote_number, old.status using errcode = 'P0001';
  end if;
  if old.status = 'finalised' and new.status in ('accepted', 'declined')
     and (to_jsonb(new) - close_columns) = (to_jsonb(old) - close_columns) then
    return new;
  end if;
  raise exception 'Quote % is %, so it can''t be changed', old.quote_number, old.status using errcode = 'P0001';
end;
$$;
`,
  };
