import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0008",
    name: "supplier_credit_notes",
    sql: `
-- Journals posted by approving or voiding a supplier credit note, and by
-- recording a refund received from the supplier or voiding that refund.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund'));

-- Credit notes from suppliers. A draft can be edited and deleted and posts
-- nothing. Approving posts Dr accounts payable / Cr each line's account and
-- GST; after that it can't change, only be voided, which posts the exact
-- reversal. The supplier's own credit note number is kept as it was typed.
-- What's been applied, refunded and is left is worked out from its
-- applications and refunds whenever it's read.
create table supplier_credit_notes (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'voided')),
  contact_id bigint not null references contacts(id),
  credit_note_date date not null,
  supplier_credit_note_number text not null
    check (length(supplier_credit_note_number) between 1 and 100 and supplier_credit_note_number ~ '[^[:space:]]'),
  reference text check (reference is null or length(reference) between 1 and 100),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
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
    (status = 'draft'
      and approval_journal_id is null
      and approve_command_source is null and approve_idempotency_key is null
      and approve_request_hash is null and approved_at is null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'approved'
      and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index supplier_credit_notes_status_idx on supplier_credit_notes (status, id);
create index supplier_credit_notes_contact_idx on supplier_credit_notes (contact_id);
-- A supplier can't have two credit notes that aren't voided (drafts
-- included) with the same number, ignoring case and spaces: "cr 7" is "CR7".
-- Bill numbers are separate.
create unique index supplier_credit_notes_number_key
  on supplier_credit_notes (contact_id, lower(regexp_replace(supplier_credit_note_number, '[[:space:]]', '', 'g')))
  where status <> 'voided';

create table supplier_credit_note_lines (
  id bigserial primary key,
  credit_note_id bigint not null references supplier_credit_notes(id),
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
create index supplier_credit_note_lines_account_idx on supplier_credit_note_lines (account_id);

-- Approved credit applied to an approved bill of the same supplier and
-- currency. Applying posts no journal (both sides are accounts payable); it
-- only lowers the bill's amount due and the credit note's remaining credit.
-- One command can apply credit to several bills, so its idempotency key is
-- shared by those rows, once per bill. Removing an application, once, fills
-- in its removal details; rows are never deleted.
create table supplier_credit_note_applications (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  credit_note_id bigint not null references supplier_credit_notes(id),
  bill_id bigint not null references bills(id),
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
  unique (command_source, idempotency_key, bill_id),
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
create index supplier_credit_note_applications_credit_note_idx on supplier_credit_note_applications (credit_note_id, id);
create index supplier_credit_note_applications_bill_idx on supplier_credit_note_applications (bill_id, id);

-- Remaining credit paid back by the supplier. Recording a refund posts
-- Dr the bank account / Cr accounts payable; voiding it posts the exact
-- reversal.
create table supplier_credit_note_refunds (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  credit_note_id bigint not null references supplier_credit_notes(id),
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
create index supplier_credit_note_refunds_credit_note_idx on supplier_credit_note_refunds (credit_note_id, id);
create index supplier_credit_note_refunds_bank_account_idx on supplier_credit_note_refunds (bank_account_id);

-- Drafts can be edited and deleted, but a draft is never voided (it's
-- deleted instead). Once approved, a credit note can only be voided: nothing
-- but its status and void details may change, and it can't be deleted. Its
-- lines are frozen with it.
create function tohyee_guard_supplier_credit_note() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'supplier_credit_notes can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.status = 'voided' then
      raise exception 'Supplier credit note #% is a draft, so it can''t be voided; delete it instead', old.id
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Supplier credit note #% is %, so it can''t be deleted', old.id, old.status
      using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at']) then
    if exists (select 1 from supplier_credit_note_applications where credit_note_id = old.id and status = 'active')
       or exists (select 1 from supplier_credit_note_refunds where credit_note_id = old.id and status = 'active') then
      raise exception 'Supplier credit note #% has credit applied or refunded, so it can''t be voided. Remove its applications and refunds first',
        old.id using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Supplier credit note #% is %, so it can''t be changed', old.id, old.status
    using errcode = 'P0001';
end;
$$;

create function tohyee_guard_supplier_credit_note_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'supplier_credit_note_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select status into parent_status from supplier_credit_notes where id = old.credit_note_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines of an approved or voided supplier credit note can''t be changed' using errcode = 'P0001';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status into parent_status from supplier_credit_notes where id = new.credit_note_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines can only be added to a draft supplier credit note' using errcode = 'P0001';
    end if;
    return new;
  end if;
  return old;
end;
$$;

-- An application is recorded as active, from an approved supplier credit
-- note to an approved bill of the same supplier and currency, dated on or
-- after both. The bill's active payments and applications can't add up to
-- more than its total, and the credit note's active applications and refunds
-- can't add up to more than its total. Both rows stay locked until the
-- transaction ends, so two commands can't both take what's left.
create function tohyee_check_supplier_credit_note_application() returns trigger
language plpgsql as $$
declare
  credit_note record;
  bill record;
  used numeric;
begin
  if new.status <> 'active' then
    raise exception 'An application is recorded as active and removed afterwards' using errcode = 'P0001';
  end if;
  select id, status, contact_id, credit_note_date, currency_code, total into credit_note
    from supplier_credit_notes where id = new.credit_note_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  select id, status, contact_id, bill_date, currency_code, total into bill
    from bills where id = new.bill_id for update;
  if not found then
    return new;
  end if;
  if credit_note.status <> 'approved' then
    raise exception 'Only approved supplier credit notes can be applied' using errcode = 'P0001';
  end if;
  if bill.status <> 'approved' then
    raise exception 'Credit can only be applied to approved bills' using errcode = 'P0001';
  end if;
  if bill.contact_id <> credit_note.contact_id then
    raise exception 'Credit can only be applied to bills of the same supplier' using errcode = 'P0001';
  end if;
  if new.currency_code <> credit_note.currency_code or new.currency_code <> bill.currency_code then
    raise exception 'Credit can only be applied in the credit note''s and bill''s currency' using errcode = 'P0001';
  end if;
  if new.application_date < credit_note.credit_note_date or new.application_date < bill.bill_date then
    raise exception 'An application can''t be dated before its credit note or bill' using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from supplier_payments where bill_id = new.bill_id and status = 'active'), 0)
       + coalesce((select sum(amount) from supplier_credit_note_applications
                    where bill_id = new.bill_id and status = 'active'), 0)
    into used;
  if used + new.amount > bill.total then
    raise exception 'Payments and credit applied to bill #% can''t add up to more than its total', bill.id
      using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from supplier_credit_note_applications
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
       + coalesce((select sum(amount) from supplier_credit_note_refunds
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
    into used;
  if used + new.amount > credit_note.total then
    raise exception 'Credit applied and refunded from supplier credit note #% can''t add up to more than its total',
      credit_note.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Applications can't be edited or deleted. Removing one, once, only fills in
-- its removal details.
create function tohyee_guard_supplier_credit_note_application() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'supplier_credit_note_applications can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Supplier credit note applications can''t be deleted; remove them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'removed'
     and (to_jsonb(new) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at'])
       = (to_jsonb(old) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at']) then
    return new;
  end if;
  raise exception 'Supplier credit note applications can''t be changed, only removed once' using errcode = 'P0001';
end;
$$;

-- A refund is recorded as active, from an approved supplier credit note, in
-- its currency and dated on or after it, and the credit note's active
-- applications and refunds can't add up to more than its total.
create function tohyee_check_supplier_credit_note_refund() returns trigger
language plpgsql as $$
declare
  credit_note record;
  used numeric;
begin
  if new.status <> 'active' then
    raise exception 'A refund is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select id, status, credit_note_date, currency_code, total into credit_note
    from supplier_credit_notes where id = new.credit_note_id for update;
  if not found then
    return new;
  end if;
  if credit_note.status <> 'approved' then
    raise exception 'Refunds can only be received for approved supplier credit notes' using errcode = 'P0001';
  end if;
  if new.currency_code <> credit_note.currency_code then
    raise exception 'A refund must be in its credit note''s currency' using errcode = 'P0001';
  end if;
  if new.refund_date < credit_note.credit_note_date then
    raise exception 'A refund can''t be dated before its credit note' using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from supplier_credit_note_applications
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
       + coalesce((select sum(amount) from supplier_credit_note_refunds
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
    into used;
  if used + new.amount > credit_note.total then
    raise exception 'Credit applied and refunded from supplier credit note #% can''t add up to more than its total',
      credit_note.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Refunds can't be edited or deleted. Voiding one, once, only fills in its
-- void details.
create function tohyee_guard_supplier_credit_note_refund() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'supplier_credit_note_refunds can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Supplier credit note refunds can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Supplier credit note refunds can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

-- A bill with active credit applied can't be voided; its credit is removed
-- first.
create function tohyee_guard_credited_bill_void() returns trigger
language plpgsql as $$
begin
  if old.status <> 'voided' and new.status = 'voided'
     and exists (select 1 from supplier_credit_note_applications where bill_id = new.id and status = 'active') then
    raise exception 'Bill #% has credit applied to it, so it can''t be voided. Remove its credit first',
      old.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- A payment can't take a bill's active payments and applied credit to more
-- than its total.
create or replace function tohyee_check_supplier_payment() returns trigger
language plpgsql as $$
declare
  bill record;
  paid numeric;
begin
  if new.status <> 'active' then
    raise exception 'A payment is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select id, status, bill_date, currency_code, total into bill
    from bills where id = new.bill_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  if bill.status <> 'approved' then
    raise exception 'Payments can only be recorded against approved bills' using errcode = 'P0001';
  end if;
  if new.currency_code <> bill.currency_code then
    raise exception 'A payment must be in its bill''s currency' using errcode = 'P0001';
  end if;
  if new.payment_date < bill.bill_date then
    raise exception 'A payment can''t be dated before its bill' using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from supplier_payments where bill_id = new.bill_id and status = 'active'), 0)
       + coalesce((select sum(amount) from supplier_credit_note_applications
                    where bill_id = new.bill_id and status = 'active'), 0)
    into paid;
  if paid + new.amount > bill.total then
    raise exception 'Payments against bill #% can''t add up to more than its total', bill.id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger supplier_credit_notes_guard
  before update or delete on supplier_credit_notes
  for each row execute function tohyee_guard_supplier_credit_note();
create trigger supplier_credit_notes_no_truncate
  before truncate on supplier_credit_notes
  for each statement execute function tohyee_guard_supplier_credit_note();
create trigger supplier_credit_note_lines_guard
  before insert or update or delete on supplier_credit_note_lines
  for each row execute function tohyee_guard_supplier_credit_note_line();
create trigger supplier_credit_note_lines_no_truncate
  before truncate on supplier_credit_note_lines
  for each statement execute function tohyee_guard_supplier_credit_note_line();
create trigger supplier_credit_note_applications_check
  before insert on supplier_credit_note_applications
  for each row execute function tohyee_check_supplier_credit_note_application();
create trigger supplier_credit_note_applications_guard
  before update or delete on supplier_credit_note_applications
  for each row execute function tohyee_guard_supplier_credit_note_application();
create trigger supplier_credit_note_applications_no_truncate
  before truncate on supplier_credit_note_applications
  for each statement execute function tohyee_guard_supplier_credit_note_application();
create trigger supplier_credit_note_refunds_check
  before insert on supplier_credit_note_refunds
  for each row execute function tohyee_check_supplier_credit_note_refund();
create trigger supplier_credit_note_refunds_guard
  before update or delete on supplier_credit_note_refunds
  for each row execute function tohyee_guard_supplier_credit_note_refund();
create trigger supplier_credit_note_refunds_no_truncate
  before truncate on supplier_credit_note_refunds
  for each statement execute function tohyee_guard_supplier_credit_note_refund();
create trigger bills_credit_guard
  before update on bills
  for each row execute function tohyee_guard_credited_bill_void();
`,
  };
