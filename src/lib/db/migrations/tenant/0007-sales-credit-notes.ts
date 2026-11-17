import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0007",
    name: "sales_credit_notes",
    sql: `
-- Journals posted by approving or voiding a sales credit note, and by
-- refunding a credit note's remaining credit or voiding that refund.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund'));

-- Credit note numbers (CN-0001, ...) are taken on approval from their own
-- counter, separate from invoice numbers. The row stays locked until the
-- approval commits, and a refused or failed approval rolls it back, so
-- numbers have no gaps.
create table sales_credit_note_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into sales_credit_note_numbering (id) values (true);

create function tohyee_guard_credit_note_numbering() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.last_number = old.last_number + 1 then
      return new;
    end if;
  end if;
  raise exception 'Credit note numbers only move forward one at a time' using errcode = 'P0001';
end;
$$;

create trigger sales_credit_note_numbering_guard
  before update or delete on sales_credit_note_numbering
  for each row execute function tohyee_guard_credit_note_numbering();
create trigger sales_credit_note_numbering_no_truncate
  before truncate on sales_credit_note_numbering
  for each statement execute function tohyee_guard_credit_note_numbering();

-- Sales credit notes to customers. A draft can be edited and deleted and
-- posts nothing. Approving numbers it and posts Dr each line's account and
-- GST / Cr accounts receivable; after that it can't change, only be voided,
-- which posts the exact reversal. What's been applied, refunded and is left
-- is worked out from its applications and refunds whenever it's read.
create table sales_credit_notes (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'voided')),
  contact_id bigint not null references contacts(id),
  credit_note_date date not null,
  reference text check (reference is null or length(reference) between 1 and 100),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  credit_note_sequence integer unique check (credit_note_sequence > 0),
  credit_note_number text unique,
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
  check (void_date is null or void_date >= credit_note_date),
  check (total = subtotal + tax_total),
  check (
    credit_note_number is null
    or credit_note_number = 'CN-' || lpad(credit_note_sequence::text, greatest(4, length(credit_note_sequence::text)), '0')
  ),
  check (
    (status = 'draft'
      and credit_note_sequence is null and credit_note_number is null and approval_journal_id is null
      and approve_command_source is null and approve_idempotency_key is null
      and approve_request_hash is null and approved_at is null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'approved'
      and credit_note_sequence is not null and credit_note_number is not null and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and credit_note_sequence is not null and credit_note_number is not null and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index sales_credit_notes_status_idx on sales_credit_notes (status, id);
create index sales_credit_notes_contact_idx on sales_credit_notes (contact_id);

create table sales_credit_note_lines (
  id bigserial primary key,
  credit_note_id bigint not null references sales_credit_notes(id),
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
  unique (credit_note_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount)
);
create index sales_credit_note_lines_account_idx on sales_credit_note_lines (account_id);

-- Approved credit applied to an approved invoice of the same customer and
-- currency. Applying posts no journal (both sides are accounts receivable);
-- it only lowers the invoice's amount due and the credit note's remaining
-- credit. One command can apply credit to several invoices, so its
-- idempotency key is shared by those rows, once per invoice. Removing an
-- application, once, fills in its removal details; rows are never deleted.
create table sales_credit_note_applications (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  credit_note_id bigint not null references sales_credit_notes(id),
  invoice_id bigint not null references sales_invoices(id),
  application_date date not null,
  amount numeric not null check (amount > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  removal_date date,
  removal_command_source text,
  removal_idempotency_key text,
  removal_request_hash text,
  removed_by_user_id uuid,
  removed_by_email text,
  removed_at timestamptz,
  unique (command_source, idempotency_key, invoice_id),
  unique (removal_command_source, removal_idempotency_key),
  check (removal_date is null or removal_date >= application_date),
  check (
    (status = 'active'
      and removal_date is null and removal_command_source is null and removal_idempotency_key is null
      and removal_request_hash is null and removed_at is null)
    or (status = 'removed'
      and removal_date is not null and removal_command_source is not null and removal_idempotency_key is not null
      and removal_request_hash is not null and removed_at is not null)
  )
);
create index sales_credit_note_applications_credit_note_idx on sales_credit_note_applications (credit_note_id, id);
create index sales_credit_note_applications_invoice_idx on sales_credit_note_applications (invoice_id, id);

-- Remaining credit paid back to the customer. Recording a refund posts
-- Dr accounts receivable / Cr the bank account; voiding it posts the exact
-- reversal.
create table sales_credit_note_refunds (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  credit_note_id bigint not null references sales_credit_notes(id),
  refund_date date not null,
  amount numeric not null check (amount > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  bank_account_id bigint not null references accounts(id),
  reference text check (reference is null or length(reference) between 1 and 100),
  journal_id bigint not null unique references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  unique (command_source, idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (void_date is null or void_date >= refund_date),
  check (
    (status = 'active'
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index sales_credit_note_refunds_credit_note_idx on sales_credit_note_refunds (credit_note_id, id);
create index sales_credit_note_refunds_bank_account_idx on sales_credit_note_refunds (bank_account_id);

-- Drafts can be edited and deleted, but a draft is never voided (it's
-- deleted instead). Once approved, a credit note can only be voided: nothing
-- but its status and void details may change, and it can't be deleted. Its
-- lines are frozen with it.
create function tohyee_guard_sales_credit_note() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_credit_notes can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.status = 'voided' then
      raise exception 'Credit note #% is a draft, so it can''t be voided; delete it instead', old.id
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Credit note % is %, so it can''t be deleted', old.credit_note_number, old.status
      using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at']) then
    if exists (select 1 from sales_credit_note_applications where credit_note_id = old.id and status = 'active')
       or exists (select 1 from sales_credit_note_refunds where credit_note_id = old.id and status = 'active') then
      raise exception 'Credit note % has credit applied or refunded, so it can''t be voided. Remove its applications and refunds first',
        old.credit_note_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Credit note % is %, so it can''t be changed', old.credit_note_number, old.status
    using errcode = 'P0001';
end;
$$;

create function tohyee_guard_sales_credit_note_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_credit_note_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select status into parent_status from sales_credit_notes where id = old.credit_note_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines of an approved or voided credit note can''t be changed' using errcode = 'P0001';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status into parent_status from sales_credit_notes where id = new.credit_note_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines can only be added to a draft credit note' using errcode = 'P0001';
    end if;
    return new;
  end if;
  return old;
end;
$$;

-- An application is recorded as active, from an approved credit note to an
-- approved invoice of the same customer and currency, dated on or after
-- both. The invoice's active payments and applications can't add up to more
-- than its total, and the credit note's active applications and refunds
-- can't add up to more than its total. Both rows stay locked until the
-- transaction ends, so two commands can't both take what's left.
create function tohyee_check_credit_note_application() returns trigger
language plpgsql as $$
declare
  credit_note record;
  invoice record;
  used numeric;
begin
  if new.status <> 'active' then
    raise exception 'An application is recorded as active and removed afterwards' using errcode = 'P0001';
  end if;
  select status, credit_note_number, contact_id, credit_note_date, currency_code, total into credit_note
    from sales_credit_notes where id = new.credit_note_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  select status, invoice_number, contact_id, invoice_date, currency_code, total into invoice
    from sales_invoices where id = new.invoice_id for update;
  if not found then
    return new;
  end if;
  if credit_note.status <> 'approved' then
    raise exception 'Only approved credit notes can be applied' using errcode = 'P0001';
  end if;
  if invoice.status <> 'approved' then
    raise exception 'Credit can only be applied to approved invoices' using errcode = 'P0001';
  end if;
  if invoice.contact_id <> credit_note.contact_id then
    raise exception 'Credit can only be applied to invoices of the same customer' using errcode = 'P0001';
  end if;
  if new.currency_code <> credit_note.currency_code or new.currency_code <> invoice.currency_code then
    raise exception 'Credit can only be applied in the credit note''s and invoice''s currency' using errcode = 'P0001';
  end if;
  if new.application_date < credit_note.credit_note_date or new.application_date < invoice.invoice_date then
    raise exception 'An application can''t be dated before its credit note or invoice' using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from customer_payments where invoice_id = new.invoice_id and status = 'active'), 0)
       + coalesce((select sum(amount) from sales_credit_note_applications
                    where invoice_id = new.invoice_id and status = 'active'), 0)
    into used;
  if used + new.amount > invoice.total then
    raise exception 'Payments and credit applied to invoice % can''t add up to more than its total', invoice.invoice_number
      using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from sales_credit_note_applications
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
       + coalesce((select sum(amount) from sales_credit_note_refunds
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
    into used;
  if used + new.amount > credit_note.total then
    raise exception 'Credit applied and refunded from credit note % can''t add up to more than its total',
      credit_note.credit_note_number using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Applications can't be edited or deleted. Removing one, once, only fills in
-- its removal details.
create function tohyee_guard_credit_note_application() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_credit_note_applications can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Credit note applications can''t be deleted; remove them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'removed'
     and (to_jsonb(new) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at'])
       = (to_jsonb(old) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at']) then
    return new;
  end if;
  raise exception 'Credit note applications can''t be changed, only removed once' using errcode = 'P0001';
end;
$$;

-- A refund is recorded as active, from an approved credit note, in its
-- currency and dated on or after it, and the credit note's active
-- applications and refunds can't add up to more than its total.
create function tohyee_check_credit_note_refund() returns trigger
language plpgsql as $$
declare
  credit_note record;
  used numeric;
begin
  if new.status <> 'active' then
    raise exception 'A refund is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select status, credit_note_number, credit_note_date, currency_code, total into credit_note
    from sales_credit_notes where id = new.credit_note_id for update;
  if not found then
    return new;
  end if;
  if credit_note.status <> 'approved' then
    raise exception 'Refunds can only be made from approved credit notes' using errcode = 'P0001';
  end if;
  if new.currency_code <> credit_note.currency_code then
    raise exception 'A refund must be in its credit note''s currency' using errcode = 'P0001';
  end if;
  if new.refund_date < credit_note.credit_note_date then
    raise exception 'A refund can''t be dated before its credit note' using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from sales_credit_note_applications
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
       + coalesce((select sum(amount) from sales_credit_note_refunds
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
    into used;
  if used + new.amount > credit_note.total then
    raise exception 'Credit applied and refunded from credit note % can''t add up to more than its total',
      credit_note.credit_note_number using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Refunds can't be edited or deleted. Voiding one, once, only fills in its
-- void details.
create function tohyee_guard_credit_note_refund() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_credit_note_refunds can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Credit note refunds can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Credit note refunds can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

-- An invoice with active credit applied can't be voided; its credit is
-- removed first.
create function tohyee_guard_credited_invoice_void() returns trigger
language plpgsql as $$
begin
  if old.status <> 'voided' and new.status = 'voided'
     and exists (select 1 from sales_credit_note_applications where invoice_id = new.id and status = 'active') then
    raise exception 'Invoice % has credit applied to it, so it can''t be voided. Remove its credit first',
      old.invoice_number using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- A payment can't take an invoice's active payments and applied credit to
-- more than its total.
create or replace function toeyee_check_customer_payment() returns trigger
language plpgsql as $$
declare
  invoice record;
  paid numeric;
begin
  if new.status <> 'active' then
    raise exception 'A payment is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select status, invoice_number, invoice_date, currency_code, total into invoice
    from sales_invoices where id = new.invoice_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  if invoice.status <> 'approved' then
    raise exception 'Payments can only be recorded against approved invoices' using errcode = 'P0001';
  end if;
  if new.currency_code <> invoice.currency_code then
    raise exception 'A payment must be in its invoice''s currency' using errcode = 'P0001';
  end if;
  if new.payment_date < invoice.invoice_date then
    raise exception 'A payment can''t be dated before its invoice' using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from customer_payments where invoice_id = new.invoice_id and status = 'active'), 0)
       + coalesce((select sum(amount) from sales_credit_note_applications
                    where invoice_id = new.invoice_id and status = 'active'), 0)
    into paid;
  if paid + new.amount > invoice.total then
    raise exception 'Payments against invoice % can''t add up to more than its total', invoice.invoice_number
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger sales_credit_notes_guard
  before update or delete on sales_credit_notes
  for each row execute function tohyee_guard_sales_credit_note();
create trigger sales_credit_notes_no_truncate
  before truncate on sales_credit_notes
  for each statement execute function tohyee_guard_sales_credit_note();
create trigger sales_credit_note_lines_guard
  before insert or update or delete on sales_credit_note_lines
  for each row execute function tohyee_guard_sales_credit_note_line();
create trigger sales_credit_note_lines_no_truncate
  before truncate on sales_credit_note_lines
  for each statement execute function tohyee_guard_sales_credit_note_line();
create trigger sales_credit_note_applications_check
  before insert on sales_credit_note_applications
  for each row execute function tohyee_check_credit_note_application();
create trigger sales_credit_note_applications_guard
  before update or delete on sales_credit_note_applications
  for each row execute function tohyee_guard_credit_note_application();
create trigger sales_credit_note_applications_no_truncate
  before truncate on sales_credit_note_applications
  for each statement execute function tohyee_guard_credit_note_application();
create trigger sales_credit_note_refunds_check
  before insert on sales_credit_note_refunds
  for each row execute function tohyee_check_credit_note_refund();
create trigger sales_credit_note_refunds_guard
  before update or delete on sales_credit_note_refunds
  for each row execute function tohyee_guard_credit_note_refund();
create trigger sales_credit_note_refunds_no_truncate
  before truncate on sales_credit_note_refunds
  for each statement execute function tohyee_guard_credit_note_refund();
create trigger sales_invoices_credit_guard
  before update on sales_invoices
  for each row execute function tohyee_guard_credited_invoice_void();
`,
  };
