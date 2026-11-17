import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0011",
    name: "bank_accounts_and_reconciliation",
    sql: `
-- Journals posted by bank transactions (spend and receive money) and by
-- transfers between bank and credit card accounts.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer'));

-- Credit cards get their own account type (a liability) so they can hold
-- statement lines. The starting chart's "Credit card" account becomes one.
update accounts set account_type = 'credit_card', updated_at = now()
 where lower(code) = '2400' and account_class = 'liability' and account_type = 'current_liability'
   and name = 'Credit card';

-- Per bank or credit card account: the saved CSV/Excel layout and the Akahu
-- bank feed link. The Akahu account id can only be linked once.
create table bank_account_settings (
  account_id bigint primary key references accounts(id),
  import_layout jsonb,
  akahu_account_id text unique check (akahu_account_id is null or akahu_account_id ~ '^acc_[A-Za-z0-9]+$'),
  akahu_account_name text,
  akahu_connection_name text,
  feed_start_date date,
  feed_active boolean not null default false,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  statement_balance numeric,
  statement_balance_at timestamptz,
  updated_at timestamptz not null default now(),
  check (not feed_active or (akahu_account_id is not null and feed_start_date is not null))
);

-- The organisation's own Akahu personal app (bank feeds, BK15): its App ID
-- token and user token, encrypted with the server's TOHYEE_SECRET_KEY. Each
-- organisation sets up its own, so feeds only ever reach its own bank logins.
-- Saving new tokens removes the old row; only one row is active at a time.
create table akahu_connections (
  id bigserial primary key,
  app_token_ciphertext text not null,
  user_token_ciphertext text not null,
  app_token_hint text not null check (length(app_token_hint) between 1 and 40),
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text,
  check ((status = 'active') = (removed_at is null))
);
create unique index akahu_connections_one_active on akahu_connections ((true)) where status = 'active';

-- A file import or a bank feed sync. Deleting an import (only while none of
-- its lines is reconciled) marks it and its lines deleted.
create table bank_statement_imports (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  account_id bigint not null references accounts(id),
  source text not null check (source in ('file', 'akahu')),
  file_name text check (file_name is null or length(file_name) between 1 and 255),
  file_format text not null check (file_format in ('csv', 'xlsx', 'ofx', 'qif', 'camt053', 'mt940', 'akahu')),
  line_count integer not null check (line_count >= 0),
  duplicate_count integer not null check (duplicate_count >= 0),
  possible_duplicate_count integer not null check (possible_duplicate_count >= 0),
  status text not null default 'active' check (status in ('active', 'deleted')),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by_email text,
  unique (command_source, idempotency_key),
  check ((status = 'active' and deleted_at is null) or (status = 'deleted' and deleted_at is not null))
);
create index bank_statement_imports_account_idx on bank_statement_imports (account_id, id);

-- What the bank says happened. Money in is positive, money out negative, from
-- the account holder's point of view. Lines aren't ledger entries: only their
-- status changes after they're added, and they're never deleted.
create table bank_statement_lines (
  id bigserial primary key,
  account_id bigint not null references accounts(id),
  import_id bigint not null references bank_statement_imports(id),
  line_date date not null,
  amount numeric not null check (amount <> 0 and scale(amount) <= 2),
  description text not null check (length(description) between 1 and 500),
  payee text check (payee is null or length(payee) <= 200),
  particulars text check (particulars is null or length(particulars) <= 100),
  code text check (code is null or length(code) <= 100),
  reference text check (reference is null or length(reference) <= 200),
  balance numeric,
  external_id text check (external_id is null or length(external_id) between 1 and 200),
  match_key text not null,
  possible_duplicate_of bigint references bank_statement_lines(id),
  status text not null default 'unreconciled' check (status in ('unreconciled', 'reconciled', 'excluded', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index bank_statement_lines_external_id_key
  on bank_statement_lines (account_id, external_id) where external_id is not null and status <> 'deleted';
create index bank_statement_lines_account_status_idx on bank_statement_lines (account_id, status, line_date, id);
create index bank_statement_lines_match_key_idx on bank_statement_lines (account_id, match_key) where status <> 'deleted';
create index bank_statement_lines_import_idx on bank_statement_lines (import_id);

create function tohyee_guard_statement_line() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'bank_statement_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Statement lines can''t be deleted; delete their import instead' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - array['status', 'updated_at']) <> (to_jsonb(old) - array['status', 'updated_at']) then
    raise exception 'Statement lines can''t be changed, only reconciled, excluded or deleted' using errcode = 'P0001';
  end if;
  if old.status = 'deleted' then
    raise exception 'A deleted statement line can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger bank_statement_lines_guard
  before update or delete on bank_statement_lines
  for each row execute function tohyee_guard_statement_line();
create trigger bank_statement_lines_no_truncate
  before truncate on bank_statement_lines
  for each statement execute function tohyee_guard_statement_line();

-- A statement line reconciled against journal lines on the same account. At
-- most one active reconciliation per statement line, and a journal line is in
-- at most one active reconciliation. Removing one, once, fills in its removal
-- details; rows are never deleted.
create table bank_reconciliations (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  statement_line_id bigint not null references bank_statement_lines(id),
  kind text not null check (kind in ('match', 'payments', 'bank_transaction', 'transfer')),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  removal_command_source text,
  removal_idempotency_key text,
  removal_request_hash text,
  removed_by_user_id uuid,
  removed_by_email text,
  removed_at timestamptz,
  unique (command_source, idempotency_key),
  unique (removal_command_source, removal_idempotency_key),
  check (
    (status = 'active' and removal_command_source is null and removal_idempotency_key is null
      and removal_request_hash is null and removed_at is null)
    or (status = 'removed' and removal_command_source is not null and removal_idempotency_key is not null
      and removal_request_hash is not null and removed_at is not null)
  )
);
create unique index bank_reconciliations_active_line_key
  on bank_reconciliations (statement_line_id) where status = 'active';

create table bank_reconciliation_items (
  id bigserial primary key,
  reconciliation_id bigint not null references bank_reconciliations(id),
  journal_line_id bigint not null references ledger_journal_lines(id),
  -- Signed like the statement line: the journal line's debit less its credit.
  amount numeric not null check (amount <> 0),
  active boolean not null default true,
  unique (reconciliation_id, journal_line_id)
);
create unique index bank_reconciliation_items_active_journal_line_key
  on bank_reconciliation_items (journal_line_id) where active;

-- Reconciliations and their items can't be edited or deleted; removing a
-- reconciliation only fills in its removal details and deactivates its items.
create function tohyee_guard_reconciliation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated', tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Reconciliations can''t be deleted; unreconcile instead' using errcode = 'P0001';
  end if;
  if tg_table_name = 'bank_reconciliations' then
    if old.status = 'active' and new.status = 'removed'
       and (to_jsonb(new) - array['status', 'removal_command_source', 'removal_idempotency_key',
              'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at'])
         = (to_jsonb(old) - array['status', 'removal_command_source', 'removal_idempotency_key',
              'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at']) then
      update bank_reconciliation_items set active = false where reconciliation_id = old.id;
      return new;
    end if;
    raise exception 'Reconciliations can''t be changed, only removed once' using errcode = 'P0001';
  end if;
  if old.active and not new.active and (to_jsonb(new) - 'active') = (to_jsonb(old) - 'active') then
    return new;
  end if;
  raise exception 'Reconciliation items can''t be changed' using errcode = 'P0001';
end;
$$;
create trigger bank_reconciliations_guard
  before update or delete on bank_reconciliations
  for each row execute function tohyee_guard_reconciliation();
create trigger bank_reconciliations_no_truncate
  before truncate on bank_reconciliations
  for each statement execute function tohyee_guard_reconciliation();
create trigger bank_reconciliation_items_guard
  before update or delete on bank_reconciliation_items
  for each row execute function tohyee_guard_reconciliation();
create trigger bank_reconciliation_items_no_truncate
  before truncate on bank_reconciliation_items
  for each statement execute function tohyee_guard_reconciliation();

-- Checked at commit: an active reconciliation's items are on the statement
-- line's account, signed the same way as their journal lines, and add up to
-- the line's amount; a statement line is reconciled exactly when it has an
-- active reconciliation.
create function tohyee_check_reconciliation(target bigint) returns void
language plpgsql as $$
declare
  rec record;
  line record;
  total numeric;
  wrong integer;
begin
  select * into rec from bank_reconciliations where id = target;
  if not found then
    return;
  end if;
  select * into line from bank_statement_lines where id = rec.statement_line_id;
  if rec.status = 'active' then
    if line.status <> 'reconciled' then
      raise exception 'Statement line % has a reconciliation but isn''t marked reconciled', line.id using errcode = '23514';
    end if;
    select coalesce(sum(i.amount), 0),
           count(*) filter (where j.account_id <> line.account_id or i.amount <> j.debit_amount - j.credit_amount)
      into total, wrong
      from bank_reconciliation_items i join ledger_journal_lines j on j.id = i.journal_line_id
     where i.reconciliation_id = rec.id;
    if wrong > 0 then
      raise exception 'Statement line % is reconciled against journal lines on another account or with other amounts', line.id
        using errcode = '23514';
    end if;
    if total <> line.amount then
      raise exception 'Statement line % (%) is reconciled against journal lines adding up to %', line.id, line.amount, total
        using errcode = '23514';
    end if;
  elsif line.status = 'reconciled'
        and not exists (select 1 from bank_reconciliations where statement_line_id = line.id and status = 'active') then
    raise exception 'Statement line % is marked reconciled without a reconciliation', line.id using errcode = '23514';
  end if;
end;
$$;

create function tohyee_check_reconciliation_trigger() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'bank_reconciliation_items' then
    perform tohyee_check_reconciliation(new.reconciliation_id);
  elsif tg_table_name = 'bank_statement_lines' then
    if new.status = 'reconciled' or old.status = 'reconciled' then
      perform tohyee_check_reconciliation(r.id) from bank_reconciliations r where r.statement_line_id = new.id;
      if new.status = 'reconciled'
         and not exists (select 1 from bank_reconciliations where statement_line_id = new.id and status = 'active') then
        raise exception 'Statement line % is marked reconciled without a reconciliation', new.id using errcode = '23514';
      end if;
    end if;
  else
    perform tohyee_check_reconciliation(new.id);
  end if;
  return null;
end;
$$;
create constraint trigger bank_reconciliations_consistent
  after insert or update on bank_reconciliations
  deferrable initially deferred
  for each row execute function tohyee_check_reconciliation_trigger();
create constraint trigger bank_reconciliation_items_consistent
  after insert on bank_reconciliation_items
  deferrable initially deferred
  for each row execute function tohyee_check_reconciliation_trigger();
create constraint trigger bank_statement_lines_consistent
  after update on bank_statement_lines
  deferrable initially deferred
  for each row execute function tohyee_check_reconciliation_trigger();

-- A journal with a reconciled line on a bank or credit card account can't be
-- reversed (voiding a payment, refund, bank transaction or transfer, or
-- correcting a journal): unreconcile it first.
create function tohyee_guard_reconciled_reversal() returns trigger
language plpgsql as $$
begin
  if new.correction_kind = 'reversal' and exists (
       select 1 from bank_reconciliation_items i join ledger_journal_lines j on j.id = i.journal_line_id
        where i.active and j.journal_id = new.related_journal_id) then
    raise exception 'This is reconciled with a bank statement line (journal %), so it can''t be voided or reversed. Unreconcile it first',
      new.related_journal_id using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ledger_journals_reconciled_reversal_guard
  before insert on ledger_journals
  for each row execute function tohyee_guard_reconciled_reversal();

-- Spend money (out of a bank or credit card account) and receive money (in),
-- with invoice-style lines. Posting is immediate; after that a bank
-- transaction can only be voided, which posts the exact reversal.
create table bank_transactions (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  kind text not null check (kind in ('spend', 'receive')),
  status text not null default 'posted' check (status in ('posted', 'voided')),
  account_id bigint not null references accounts(id),
  contact_id bigint not null references contacts(id),
  transaction_date date not null,
  reference text check (reference is null or length(reference) between 1 and 100),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
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
  check (total = subtotal + tax_total),
  check (void_date is null or void_date >= transaction_date),
  check (
    (status = 'posted' and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided' and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index bank_transactions_account_idx on bank_transactions (account_id, transaction_date);
create index bank_transactions_contact_idx on bank_transactions (contact_id);

create table bank_transaction_lines (
  id bigserial primary key,
  bank_transaction_id bigint not null references bank_transactions(id),
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
  unique (bank_transaction_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount)
);

-- Money moved between two of the organisation's bank or credit card accounts.
create table bank_transfers (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'posted' check (status in ('posted', 'voided')),
  from_account_id bigint not null references accounts(id),
  to_account_id bigint not null references accounts(id),
  transfer_date date not null,
  amount numeric not null check (amount > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
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
  check (from_account_id <> to_account_id),
  check (void_date is null or void_date >= transfer_date),
  check (
    (status = 'posted' and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided' and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);

-- Bank transactions and transfers can't be edited or deleted, only voided once.
create function tohyee_guard_bank_document() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated', tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception '% rows can''t be deleted; void them instead', tg_table_name using errcode = 'P0001';
  end if;
  if tg_table_name = 'bank_transaction_lines' then
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
create trigger bank_transactions_guard
  before update or delete on bank_transactions
  for each row execute function tohyee_guard_bank_document();
create trigger bank_transactions_no_truncate
  before truncate on bank_transactions
  for each statement execute function tohyee_guard_bank_document();
create trigger bank_transaction_lines_guard
  before update or delete on bank_transaction_lines
  for each row execute function tohyee_guard_bank_document();
create trigger bank_transaction_lines_no_truncate
  before truncate on bank_transaction_lines
  for each statement execute function tohyee_guard_bank_document();
create trigger bank_transfers_guard
  before update or delete on bank_transfers
  for each row execute function tohyee_guard_bank_document();
create trigger bank_transfers_no_truncate
  before truncate on bank_transfers
  for each statement execute function tohyee_guard_bank_document();

-- Bank rules suggest a bank transaction for matching statement lines. They're
-- settings, not history, so they can be edited and deleted.
create table bank_rules (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  is_active boolean not null default true,
  priority integer not null default 100,
  account_id bigint references accounts(id),
  direction text not null default 'any' check (direction in ('any', 'in', 'out')),
  match_field text not null default 'any'
    check (match_field in ('any', 'description', 'payee', 'particulars', 'code', 'reference')),
  match_text text not null check (length(match_text) between 1 and 200),
  contact_id bigint not null references contacts(id),
  target_account_id bigint not null references accounts(id),
  tax_code_id bigint references tax_codes(id),
  amounts_mode text not null default 'inclusive' check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  line_description text check (line_description is null or length(line_description) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The GST return counts bank transactions: spend money like a bill, receive
-- money like an invoice.
alter table gst_return_lines drop constraint gst_return_lines_event_type_check;
alter table gst_return_lines add constraint gst_return_lines_event_type_check
  check (event_type in ('invoice_approved', 'invoice_voided', 'credit_note_approved', 'credit_note_voided',
                        'bill_approved', 'bill_voided', 'supplier_credit_note_approved', 'supplier_credit_note_voided',
                        'bank_transaction_posted', 'bank_transaction_voided'));
alter table gst_return_lines drop constraint gst_return_lines_document_type_check;
alter table gst_return_lines add constraint gst_return_lines_document_type_check
  check (document_type in ('sales_invoice', 'sales_credit_note', 'bill', 'supplier_credit_note', 'bank_transaction'));
`,
  };
