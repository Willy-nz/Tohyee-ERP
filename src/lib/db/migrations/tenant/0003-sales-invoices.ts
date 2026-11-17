import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0003",
    name: "sales_invoices",
    sql: `
-- How GST returns will be worked out. Stored now; the GST return uses it later.
alter table organisation_settings
  add column gst_basis text not null default 'invoice'
    check (gst_basis in ('invoice', 'payments', 'hybrid'));

-- Journals posted by approving or voiding a sales invoice.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice'));

-- Invoices post to accounts receivable and GST, found by role so re-coding
-- them doesn't break posting (and they can't be archived). New organisations
-- get these from the default chart; existing ones get them here if they
-- still have the default accounts.
update accounts set system_key = 'accounts_receivable', updated_at = now()
 where lower(code) = '1100' and account_class = 'asset' and system_key is null
   and not exists (select 1 from accounts where system_key = 'accounts_receivable');
update accounts set system_key = 'gst', updated_at = now()
 where lower(code) = '2100' and account_class = 'liability' and system_key is null
   and not exists (select 1 from accounts where system_key = 'gst');

-- Invoice numbers are taken on approval from this counter. The row stays
-- locked until the approval commits, and a refused or failed approval rolls
-- the counter back, so numbers have no gaps.
create table sales_invoice_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into sales_invoice_numbering (id) values (true);

create function toeyee_guard_invoice_numbering() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.last_number = old.last_number + 1 then
      return new;
    end if;
  end if;
  raise exception 'Invoice numbers only move forward one at a time' using errcode = 'P0001';
end;
$$;

create trigger sales_invoice_numbering_guard
  before update or delete on sales_invoice_numbering
  for each row execute function toeyee_guard_invoice_numbering();
create trigger sales_invoice_numbering_no_truncate
  before truncate on sales_invoice_numbering
  for each statement execute function toeyee_guard_invoice_numbering();

create table sales_invoices (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'voided')),
  contact_id bigint not null references contacts(id),
  invoice_date date not null,
  due_date date not null,
  reference text check (reference is null or length(reference) between 1 and 100),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  invoice_sequence integer unique check (invoice_sequence > 0),
  invoice_number text unique,
  approval_journal_id bigint unique references ledger_journals(id),
  approve_command_source text,
  approve_idempotency_key text,
  approve_request_hash text,
  approved_by_user_id uuid,
  approved_by_email text,
  approved_at timestamptz,
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (due_date >= invoice_date),
  check (void_date is null or void_date >= invoice_date),
  check (total = subtotal + tax_total),
  check (
    invoice_number is null
    or invoice_number = 'INV-' || lpad(invoice_sequence::text, greatest(4, length(invoice_sequence::text)), '0')
  ),
  check (
    (status = 'draft'
      and invoice_sequence is null and invoice_number is null and approval_journal_id is null
      and approve_command_source is null and approve_idempotency_key is null
      and approve_request_hash is null and approved_at is null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'approved'
      and invoice_sequence is not null and invoice_number is not null and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and invoice_sequence is not null and invoice_number is not null and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index sales_invoices_status_idx on sales_invoices (status, id);
create index sales_invoices_contact_idx on sales_invoices (contact_id);

create table sales_invoice_lines (
  id bigserial primary key,
  invoice_id bigint not null references sales_invoices(id),
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
  unique (invoice_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount)
);
create index sales_invoice_lines_account_idx on sales_invoice_lines (account_id);

-- Drafts can be edited and deleted. Once approved, an invoice can only be
-- voided: nothing but its status and void details may change, and it can't
-- be deleted. Its lines are frozen with it.
create function toeyee_guard_sales_invoice() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_invoices can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Invoice % is %, so it can''t be deleted', old.invoice_number, old.status
      using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at']) then
    return new;
  end if;
  raise exception 'Invoice % is %, so it can''t be changed', old.invoice_number, old.status
    using errcode = 'P0001';
end;
$$;

create function toeyee_guard_sales_invoice_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_invoice_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select status into parent_status from sales_invoices where id = old.invoice_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines of an approved or voided invoice can''t be changed' using errcode = 'P0001';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status into parent_status from sales_invoices where id = new.invoice_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines can only be added to a draft invoice' using errcode = 'P0001';
    end if;
    return new;
  end if;
  return old;
end;
$$;

create trigger sales_invoices_guard
  before update or delete on sales_invoices
  for each row execute function toeyee_guard_sales_invoice();
create trigger sales_invoices_no_truncate
  before truncate on sales_invoices
  for each statement execute function toeyee_guard_sales_invoice();
create trigger sales_invoice_lines_guard
  before insert or update or delete on sales_invoice_lines
  for each row execute function toeyee_guard_sales_invoice_line();
create trigger sales_invoice_lines_no_truncate
  before truncate on sales_invoice_lines
  for each statement execute function toeyee_guard_sales_invoice_line();
`,
  };
