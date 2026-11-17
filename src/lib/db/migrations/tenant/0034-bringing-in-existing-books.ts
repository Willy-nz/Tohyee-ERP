import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0034",
    name: "bringing_in_existing_books",
    sql: `
-- Bringing in an organisation's existing books (examples IM1-IM16).

-- An account's usual GST code, offered when the account is picked on a line
-- (like the tax code on another system's chart of accounts).
alter table accounts add column default_tax_code_id bigint references tax_codes(id);

-- Opening balances are posted by one journal of their own origin.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal',
                    'opening_balance'));

-- Open invoices and bills at the conversion date (IM5-IM9). They keep the
-- number they had (an opening invoice has no INV sequence of its own; new
-- invoices skip any INV-number already taken), post Dr accounts receivable /
-- Cr conversion clearing (bills the other way) with no GST, and never count
-- in GST returns or sales reports.
alter table sales_invoices add column is_opening_balance boolean not null default false;
alter table bills add column is_opening_balance boolean not null default false;
do $$
declare
  item record;
begin
  for item in
    select conname from pg_constraint
     where conrelid = 'sales_invoices'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%invoice_sequence%'
  loop
    execute format('alter table sales_invoices drop constraint %I', item.conname);
  end loop;
end;
$$;
alter table sales_invoices add constraint sales_invoices_number_check check (
  case when is_opening_balance
    then invoice_sequence is null and (invoice_number is null or length(invoice_number) between 1 and 100)
    else invoice_number is null
      or invoice_number = 'INV-' || lpad(invoice_sequence::text, greatest(4, length(invoice_sequence::text)), '0')
  end
);
alter table sales_invoices add constraint sales_invoices_status_check_fields check (
  (status = 'draft'
    and invoice_sequence is null and invoice_number is null and approval_journal_id is null
    and approve_command_source is null and approve_idempotency_key is null
    and approve_request_hash is null and approved_at is null
    and void_date is null and void_journal_id is null and void_command_source is null
    and void_idempotency_key is null and void_request_hash is null and voided_at is null)
  or (status = 'approved'
    and (is_opening_balance or invoice_sequence is not null) and invoice_number is not null and approval_journal_id is not null
    and approve_command_source is not null and approve_idempotency_key is not null
    and approve_request_hash is not null and approved_at is not null
    and void_date is null and void_journal_id is null and void_command_source is null
    and void_idempotency_key is null and void_request_hash is null and voided_at is null)
  or (status = 'voided'
    and (is_opening_balance or invoice_sequence is not null) and invoice_number is not null and approval_journal_id is not null
    and approve_command_source is not null and approve_idempotency_key is not null
    and approve_request_hash is not null and approved_at is not null
    and void_date is not null and void_journal_id is not null and void_command_source is not null
    and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
);
alter table sales_invoices add constraint sales_invoices_opening_check
  check (not is_opening_balance or (tax_total = 0 and amounts_mode = 'no_tax'));
alter table bills add constraint bills_opening_check
  check (not is_opening_balance or (tax_total = 0 and amounts_mode = 'no_tax'));

-- The opening balances as brought in (IM1-IM4): once per organisation, never
-- changed. The lines are the trial balance as imported; the journal is what
-- was posted from it.
create table conversion_balances (
  id boolean primary key default true check (id),
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  conversion_date date not null,
  journal_id bigint not null unique references ledger_journals(id),
  invoice_count integer not null check (invoice_count >= 0),
  bill_count integer not null check (bill_count >= 0),
  stock_count integer not null check (stock_count >= 0),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create table conversion_balance_lines (
  id bigserial primary key,
  line_order integer not null unique check (line_order > 0),
  account_id bigint not null unique references accounts(id),
  debit_amount numeric not null check (debit_amount >= 0),
  credit_amount numeric not null check (credit_amount >= 0),
  check ((debit_amount > 0) <> (credit_amount > 0))
);
create trigger conversion_balances_append_only
  before update or delete on conversion_balances
  for each row execute function toeyee_forbid_mutation();
create trigger conversion_balances_no_truncate
  before truncate on conversion_balances
  for each statement execute function toeyee_forbid_mutation();
create trigger conversion_balance_lines_append_only
  before update or delete on conversion_balance_lines
  for each row execute function toeyee_forbid_mutation();
create trigger conversion_balance_lines_no_truncate
  before truncate on conversion_balance_lines
  for each statement execute function toeyee_forbid_mutation();

-- The imported trial balance balances, checked at commit.
create function tohyee_check_conversion_lines() returns trigger
language plpgsql as $$
declare
  debits numeric;
  credits numeric;
begin
  select coalesce(sum(debit_amount), 0), coalesce(sum(credit_amount), 0) into debits, credits from conversion_balance_lines;
  if debits <> credits then
    raise exception 'The opening balances don''t balance: debits %, credits %', debits, credits using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger conversion_balance_lines_balance
  after insert on conversion_balance_lines deferrable initially deferred
  for each row execute function tohyee_check_conversion_lines();

-- How each kind of file was last mapped (column headings per field), so the
-- next file from the same system is read the same way.
create table import_mappings (
  kind text primary key check (kind in ('accounts', 'contacts', 'items', 'trial_balance', 'stock', 'open_invoices', 'open_bills')),
  preset text not null check (preset in ('tohyee', 'other_system')),
  columns jsonb not null,
  options jsonb not null default '{}'::jsonb,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
`,
  };
