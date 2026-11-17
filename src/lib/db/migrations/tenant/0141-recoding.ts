import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0141",
    name: "recoding",
    sql: `
-- Recoding a posted line (#258/#259, examples RCD1-RCD6): only its account
-- and tracking change. A correcting journal on the document's own date moves
-- the amount from the old account to the new; the document line is updated
-- to match. GST, amounts, contacts and control accounts never change.
create table document_recodes (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  document_type text not null check (document_type in ('invoice', 'bill', 'bank_transaction')),
  document_id bigint not null,
  line_id bigint not null,
  line_order integer not null check (line_order > 0),
  from_account_id bigint not null references accounts(id),
  to_account_id bigint not null references accounts(id),
  from_tracking jsonb not null default '{}'::jsonb,
  to_tracking jsonb not null default '{}'::jsonb,
  amount numeric(18, 2) not null,
  journal_id bigint not null references ledger_journals(id),
  reason text not null check (length(reason) between 1 and 500),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create index document_recodes_document on document_recodes (document_type, document_id);
create trigger document_recodes_no_change before update or delete on document_recodes for each row execute function toeyee_forbid_delete();

-- Only the recode function sets tohyee.recoding, for the one statement that
-- changes a line's account and tracking; anything else is still refused.
create or replace function tohyee_recode_allowed(old_row jsonb, new_row jsonb) returns boolean
language sql stable as $fn$
  select coalesce(current_setting('tohyee.recoding', true), '') = 'on'
     and (old_row - array['account_id', 'tracking']) = (new_row - array['account_id', 'tracking'])
$fn$;

create or replace function tohyee_guard_bill_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'bill_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    select status into parent_status from bills where id = old.bill_id for share;
    if parent_status = 'approved' and tohyee_recode_allowed(to_jsonb(old), to_jsonb(new)) then
      return new;
    end if;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select status into parent_status from bills where id = old.bill_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines of an approved or voided bill can''t be changed' using errcode = 'P0001';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status into parent_status from bills where id = new.bill_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines can only be added to a draft bill' using errcode = 'P0001';
    end if;
    return new;
  end if;
  return old;
end;
$$;

create or replace function toeyee_guard_sales_invoice_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_invoice_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    select status into parent_status from sales_invoices where id = old.invoice_id for share;
    if parent_status = 'approved' and tohyee_recode_allowed(to_jsonb(old), to_jsonb(new)) then
      return new;
    end if;
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

create or replace function tohyee_guard_bank_document() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated', tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception '% rows can''t be deleted; void them instead', tg_table_name using errcode = 'P0001';
  end if;
  if tg_table_name = 'bank_transaction_lines' then
    select status into parent_status from bank_transactions where id = old.bank_transaction_id for share;
    if parent_status = 'posted' and tohyee_recode_allowed(to_jsonb(old), to_jsonb(new)) then
      return new;
    end if;
    raise exception 'Bank transaction lines can''t be changed' using errcode = 'P0001';
  end if;
  if old.status = 'posted' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception '% can''t be changed, only voided once', tg_table_name using errcode = 'P0001';
end;
$$;

alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal',
                    'opening_balance', 'payroll', 'livestock_valuation', 'livestock_rations', 'recode'));
`,
  };
