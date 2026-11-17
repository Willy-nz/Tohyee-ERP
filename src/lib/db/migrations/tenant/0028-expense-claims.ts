import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0028",
    name: "expense_claims",
    sql: `
-- Expense claims (examples EC1-EC12): a member enters receipts they paid
-- for themselves and submits the claim; approving posts Dr each expense
-- account (net) / Dr GST / Cr expense claims payable; paying it posts
-- Dr expense claims payable / Cr the bank account. Declining returns a
-- submitted claim to its claimant as a draft; voiding an approved claim with
-- no active payments posts the exact reversal.

-- The liability approved claims are owed on, like accounts payable. New
-- organisations get it with the starting chart (2010); existing ones get it
-- here, at 2010 or the next free code after it.
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2010, 2099) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Expense claims payable', 'liability', 'current_liability', 'expense_claims_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'expense_claims_payable');

alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment'));

alter table record_notes drop constraint record_notes_record_type_check;
alter table record_notes add constraint record_notes_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim'));
alter table record_attachments drop constraint record_attachments_record_type_check;
alter table record_attachments add constraint record_attachments_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim'));

create table expense_claims (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'voided')),
  claimant_user_id uuid,
  claimant_email text not null check (length(claimant_email) between 1 and 320),
  description text check (description is null or length(description) between 1 and 500),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  total numeric not null default 0 check (total >= 0),
  tax_total numeric not null default 0 check (tax_total >= 0),
  submitted_at timestamptz,
  declined_at timestamptz,
  declined_by_email text,
  decline_reason text check (decline_reason is null or length(decline_reason) between 1 and 500),
  claim_date date,
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check ((status in ('approved', 'voided')) = (approval_journal_id is not null and claim_date is not null and approved_at is not null)),
  check ((status = 'voided') = (void_journal_id is not null and void_date is not null and voided_at is not null)),
  check ((status = 'submitted') = (submitted_at is not null) or status in ('approved', 'voided')),
  check (void_date is null or void_date >= claim_date)
);
create index expense_claims_status_idx on expense_claims (status, id);
create index expense_claims_claimant_idx on expense_claims (claimant_user_id, id);

-- Receipts, tax inclusive: amount = net + GST.
create table expense_claim_receipts (
  id bigserial primary key,
  claim_id bigint not null references expense_claims(id),
  line_order integer not null check (line_order > 0),
  receipt_date date not null,
  supplier_name text not null check (length(supplier_name) between 1 and 200),
  description text not null check (length(description) between 1 and 500),
  account_id bigint not null references accounts(id),
  tax_code_id bigint references tax_codes(id),
  tax_rate numeric not null default 0 check (tax_rate >= 0),
  amount numeric not null check (amount > 0),
  net_amount numeric not null,
  tax_amount numeric not null check (tax_amount >= 0),
  tracking jsonb not null default '{}'::jsonb,
  unique (claim_id, line_order),
  check (net_amount + tax_amount = amount)
);
create trigger expense_claim_receipts_tracking before insert or update on expense_claim_receipts
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();

-- Only drafts change or are deleted. A submitted claim goes back to draft
-- (declined) or on to approved; an approved one only to voided, once, and
-- then only its void details change; a voided one never changes.
create function tohyee_guard_expense_claim() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'expense_claims can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only draft expense claims can be deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.status = 'draft' and new.status in ('draft', 'submitted') then
    return new;
  end if;
  if old.status = 'submitted' and new.status in ('draft', 'approved') then
    return new;
  end if;
  if old.status = 'approved' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
            'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at', 'updated_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
            'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at', 'updated_at']) then
    if exists (select 1 from expense_claim_payments where claim_id = new.id and status = 'active') then
      raise exception 'Expense claim #% has payments against it, so it can''t be voided. Void its payments first', old.id
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Expense claim #% is % and can''t change like that', old.id, old.status using errcode = 'P0001';
end;
$$;

-- Receipts only change while their claim is a draft.
create function tohyee_guard_expense_claim_receipt() returns trigger
language plpgsql as $$
declare
  claim_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'expense_claim_receipts can''t be truncated' using errcode = 'P0001';
  end if;
  select status into claim_status from expense_claims
   where id = case when tg_op = 'DELETE' then old.claim_id else new.claim_id end;
  if claim_status is distinct from 'draft' then
    raise exception 'Receipts can only change while their expense claim is a draft' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.claim_id <> old.claim_id then
    raise exception 'A receipt stays on its expense claim' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create table expense_claim_payments (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  claim_id bigint not null references expense_claims(id),
  payment_date date not null,
  amount numeric not null check (amount > 0),
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
  check (void_date is null or void_date >= payment_date),
  check (
    (status = 'active'
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index expense_claim_payments_claim_idx on expense_claim_payments (claim_id, id);

-- A payment is recorded as active against an approved claim, dated on or
-- after it, and a claim's active payments never add up to more than its
-- total. The claim stays locked until the transaction ends.
create function tohyee_check_expense_claim_payment() returns trigger
language plpgsql as $$
declare
  claim record;
  paid numeric;
begin
  if new.status <> 'active' then
    raise exception 'A payment is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select id, status, claim_date, total into claim from expense_claims where id = new.claim_id for update;
  if not found then
    return new;
  end if;
  if claim.status <> 'approved' then
    raise exception 'Payments can only be recorded against approved expense claims' using errcode = 'P0001';
  end if;
  if new.payment_date < claim.claim_date then
    raise exception 'A payment can''t be dated before its expense claim' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount), 0) into paid from expense_claim_payments where claim_id = new.claim_id and status = 'active';
  if paid + new.amount > claim.total then
    raise exception 'Payments against expense claim #% can''t add up to more than its total', claim.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create function tohyee_guard_expense_claim_payment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'expense_claim_payments can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Expense claim payments can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Expense claim payments can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

create trigger expense_claims_guard
  before update or delete on expense_claims
  for each row execute function tohyee_guard_expense_claim();
create trigger expense_claims_no_truncate
  before truncate on expense_claims
  for each statement execute function tohyee_guard_expense_claim();
create trigger expense_claim_receipts_guard
  before insert or update or delete on expense_claim_receipts
  for each row execute function tohyee_guard_expense_claim_receipt();
create trigger expense_claim_receipts_no_truncate
  before truncate on expense_claim_receipts
  for each statement execute function tohyee_guard_expense_claim_receipt();
create trigger expense_claim_payments_check
  before insert on expense_claim_payments
  for each row execute function tohyee_check_expense_claim_payment();
create trigger expense_claim_payments_guard
  before update or delete on expense_claim_payments
  for each row execute function tohyee_guard_expense_claim_payment();
create trigger expense_claim_payments_no_truncate
  before truncate on expense_claim_payments
  for each statement execute function tohyee_guard_expense_claim_payment();

-- The GST return counts approved claims like bills (on the claim date on
-- the invoice basis, when paid on the payments and hybrid bases). Receipts
-- have a supplier's name rather than a contact, so filed lines from claims
-- have no contact.
alter table gst_return_lines alter column contact_id drop not null;
alter table gst_return_lines drop constraint gst_return_lines_event_type_check;
alter table gst_return_lines add constraint gst_return_lines_event_type_check
  check (event_type in ('invoice_approved', 'invoice_voided', 'credit_note_approved', 'credit_note_voided',
                        'bill_approved', 'bill_voided', 'supplier_credit_note_approved', 'supplier_credit_note_voided',
                        'bank_transaction_posted', 'bank_transaction_voided',
                        'customer_payment', 'customer_payment_voided',
                        'credit_note_applied', 'credit_note_application_removed',
                        'credit_note_refunded', 'credit_note_refund_voided',
                        'overpayment_applied', 'overpayment_application_removed',
                        'supplier_payment', 'supplier_payment_voided',
                        'supplier_credit_note_applied', 'supplier_credit_note_application_removed',
                        'supplier_credit_note_refunded', 'supplier_credit_note_refund_voided',
                        'expense_claim_approved', 'expense_claim_voided',
                        'expense_claim_payment', 'expense_claim_payment_voided'));
alter table gst_return_lines drop constraint gst_return_lines_document_type_check;
alter table gst_return_lines add constraint gst_return_lines_document_type_check
  check (document_type in ('sales_invoice', 'sales_credit_note', 'bill', 'supplier_credit_note', 'bank_transaction',
                           'expense_claim'));
`,
  };
