import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0024",
    name: "sales_documents",
    sql: `
-- Quotes (examples QT1-QT8), repeating invoices (RI1-RI10) and what printed
-- documents show about the organisation (PD1-PD8). Quotes and templates
-- post nothing; only the invoices they make ever reach the ledger.

-- What printed invoices, credit notes and quotes show (PD1). The GST number
-- is stored as digits, like contacts'.
alter table organisation_settings
  add column postal_address text check (postal_address is null or length(postal_address) between 1 and 500),
  add column gst_number text check (gst_number is null or gst_number ~ '^[0-9]{8,9}$'),
  add column payment_details text check (payment_details is null or length(payment_details) between 1 and 1000);

-- Quote numbers are taken when a quote is finalised, from their own counter
-- that only moves forward by one, so QU- numbers have no gaps (QT2).
create table quote_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into quote_numbering (id) values (true);
create trigger quote_numbering_guard
  before update or delete on quote_numbering
  for each row execute function toeyee_guard_invoice_numbering();
create trigger quote_numbering_no_truncate
  before truncate on quote_numbering
  for each statement execute function toeyee_guard_invoice_numbering();

create table quotes (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'finalised', 'accepted', 'declined')),
  contact_id bigint not null references contacts(id),
  quote_date date not null,
  expiry_date date,
  reference text check (reference is null or length(reference) between 1 and 100),
  terms text check (terms is null or length(terms) between 1 and 2000),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  custom_fields jsonb not null default '{}'::jsonb,
  salesperson_id bigint references salespeople(id),
  copied_from_quote_id bigint references quotes(id),
  quote_sequence integer unique check (quote_sequence > 0),
  quote_number text unique,
  finalise_command_source text,
  finalise_idempotency_key text,
  finalise_request_hash text,
  finalised_by_user_id uuid,
  finalised_by_email text,
  finalised_at timestamptz,
  -- Accepting makes a draft invoice carrying the quote's lines (QT3).
  invoice_id bigint unique references sales_invoices(id),
  close_command_source text,
  close_idempotency_key text,
  close_request_hash text,
  closed_by_user_id uuid,
  closed_by_email text,
  closed_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (finalise_command_source, finalise_idempotency_key),
  unique (close_command_source, close_idempotency_key),
  check (expiry_date is null or expiry_date >= quote_date),
  check (total = subtotal + tax_total),
  check (quote_number is null or quote_number = 'QU-' || lpad(quote_sequence::text, greatest(4, length(quote_sequence::text)), '0')),
  check ((status = 'draft') = (quote_number is null)),
  check ((status = 'draft') = (finalised_at is null)),
  check ((status in ('draft', 'finalised')) = (closed_at is null)),
  check ((status = 'accepted') = (invoice_id is not null))
);
create index quotes_status_idx on quotes (status, id);
create index quotes_contact_idx on quotes (contact_id);

create table quote_lines (
  id bigserial primary key,
  quote_id bigint not null references quotes(id),
  line_order integer not null check (line_order > 0),
  description text not null check (length(description) between 1 and 500),
  quantity numeric not null check (quantity > 0),
  unit_price numeric not null check (unit_price > 0),
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
  unique (quote_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount),
  check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null))
);

-- A draft can be edited and deleted. A finalised quote is locked: it can
-- only become accepted (with its invoice) or declined, once. Its lines are
-- frozen with it (QT2, QT3, QT4).
create function tohyee_guard_quote() returns trigger
language plpgsql as $$
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
     and (to_jsonb(new) - array['status', 'invoice_id', 'close_command_source', 'close_idempotency_key',
            'close_request_hash', 'closed_by_user_id', 'closed_by_email', 'closed_at', 'updated_at'])
       = (to_jsonb(old) - array['status', 'invoice_id', 'close_command_source', 'close_idempotency_key',
            'close_request_hash', 'closed_by_user_id', 'closed_by_email', 'closed_at', 'updated_at']) then
    return new;
  end if;
  raise exception 'Quote % is %, so it can''t be changed', old.quote_number, old.status using errcode = 'P0001';
end;
$$;
create trigger quotes_guard before update or delete on quotes
  for each row execute function tohyee_guard_quote();
create trigger quotes_no_truncate before truncate on quotes
  for each statement execute function tohyee_guard_quote();

create function tohyee_guard_quote_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'quote_lines can''t be truncated' using errcode = 'P0001';
  end if;
  select status into parent_status from quotes
   where id = case when tg_op = 'DELETE' then old.quote_id else new.quote_id end for share;
  if parent_status <> 'draft' then
    raise exception 'Lines of a finalised quote can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.quote_id <> new.quote_id then
    raise exception 'A quote line can''t move to another quote' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger quote_lines_guard before insert or update or delete on quote_lines
  for each row execute function tohyee_guard_quote_line();
create trigger quote_lines_no_truncate before truncate on quote_lines
  for each statement execute function tohyee_guard_quote_line();
create trigger quote_lines_item before insert or update on quote_lines
  for each row execute function tohyee_check_line_item();
create trigger quote_lines_tracking before insert or update on quote_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger quotes_custom_fields before insert or update on quotes
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger quote_lines_custom_fields before insert or update on quote_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');

-- Repeating invoice templates (RI1-RI10). Every N weeks or months from the
-- start date (the day is kept, or the month's last day when it's shorter),
-- until the end date if there is one. Templates are ended, never deleted.
create table repeating_invoices (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  contact_id bigint not null references contacts(id),
  reference text check (reference is null or length(reference) between 1 and 100),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  custom_fields jsonb not null default '{}'::jsonb,
  salesperson_id bigint references salespeople(id),
  period text not null check (period in ('week', 'month')),
  every integer not null check (every between 1 and 99),
  start_date date not null,
  end_date date,
  due_rule text not null check (due_rule in ('terms', 'days_after')),
  due_days integer check (due_days between 0 and 365),
  save_as text not null check (save_as in ('draft', 'approve')),
  -- RI7: dates before a resume aren't made.
  resumed_from date,
  -- RI9: why the last run stopped (cleared by the next good one).
  last_error text,
  last_error_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (end_date is null or end_date >= start_date),
  check ((due_rule = 'days_after') = (due_days is not null)),
  check (total = subtotal + tax_total)
);
create trigger repeating_invoices_no_delete before delete on repeating_invoices
  for each row execute function toeyee_forbid_delete();
create trigger repeating_invoices_no_truncate before truncate on repeating_invoices
  for each statement execute function toeyee_forbid_delete();

-- An ended template can't change or start again (RI7).
create function tohyee_guard_repeating_invoice() returns trigger
language plpgsql as $$
begin
  if old.status = 'ended' then
    raise exception 'This repeating invoice has ended, so it can''t be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger repeating_invoices_guard before update on repeating_invoices
  for each row execute function tohyee_guard_repeating_invoice();

create table repeating_invoice_lines (
  id bigserial primary key,
  repeating_invoice_id bigint not null references repeating_invoices(id),
  line_order integer not null check (line_order > 0),
  description text not null check (length(description) between 1 and 500),
  quantity numeric not null check (quantity > 0),
  unit_price numeric not null check (unit_price > 0),
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
  unique (repeating_invoice_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount),
  check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null))
);
create function tohyee_guard_repeating_invoice_line() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'repeating_invoice_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if (select status from repeating_invoices
       where id = case when tg_op = 'DELETE' then old.repeating_invoice_id else new.repeating_invoice_id end) = 'ended' then
    raise exception 'Lines of an ended repeating invoice can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger repeating_invoice_lines_guard before insert or update or delete on repeating_invoice_lines
  for each row execute function tohyee_guard_repeating_invoice_line();
create trigger repeating_invoice_lines_no_truncate before truncate on repeating_invoice_lines
  for each statement execute function tohyee_guard_repeating_invoice_line();
create trigger repeating_invoice_lines_item before insert or update on repeating_invoice_lines
  for each row execute function tohyee_check_line_item();
create trigger repeating_invoice_lines_tracking before insert or update on repeating_invoice_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger repeating_invoices_custom_fields before insert or update on repeating_invoices
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger repeating_invoice_lines_custom_fields before insert or update on repeating_invoice_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');

-- One row per scheduled date that made an invoice: the unique key is what
-- stops a date being made twice, however often the job runs (RI3). Rows
-- are never changed or deleted, except that deleting the draft invoice
-- clears its link (RI10), so the date isn't made again.
create table repeating_invoice_runs (
  id bigserial primary key,
  repeating_invoice_id bigint not null references repeating_invoices(id),
  scheduled_date date not null,
  invoice_id bigint unique references sales_invoices(id) on delete set null,
  invoice_deleted boolean not null default false,
  outcome text not null check (outcome in ('draft', 'approved', 'approval_refused')),
  message text check (message is null or length(message) between 1 and 1000),
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (repeating_invoice_id, scheduled_date),
  check (outcome <> 'approval_refused' or message is not null),
  check (outcome <> 'draft' or message is null)
);
create function tohyee_guard_repeating_invoice_run() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'repeating_invoice_runs can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A repeating invoice''s history can''t be deleted' using errcode = 'P0001';
  end if;
  if old.invoice_id is not null and new.invoice_id is null
     and (to_jsonb(new) - array['invoice_id', 'invoice_deleted']) = (to_jsonb(old) - array['invoice_id', 'invoice_deleted']) then
    new.invoice_deleted := true;
    return new;
  end if;
  raise exception 'A repeating invoice''s history can''t be changed' using errcode = 'P0001';
end;
$$;
create trigger repeating_invoice_runs_guard before update or delete on repeating_invoice_runs
  for each row execute function tohyee_guard_repeating_invoice_run();
create trigger repeating_invoice_runs_no_truncate before truncate on repeating_invoice_runs
  for each statement execute function tohyee_guard_repeating_invoice_run();
`,
  };
