import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0300",
    name: "spreading",
    sql: `
-- Spreading (examples SW1-SW14): income or a cost that belongs to other
-- months than the one it was billed or paid in. Four kinds, each with one
-- balance sheet account; a month's shares post as one journal a kind.

-- The balance sheet account each kind is held in. One row; a null account
-- means that kind isn't set up yet.
create table spreading_settings (
  only_row boolean primary key default true check (only_row),
  prepayment_account_id bigint references accounts(id),
  income_in_advance_account_id bigint references accounts(id),
  accrued_expense_account_id bigint references accounts(id),
  accrued_income_account_id bigint references accounts(id),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

-- A month's journal for one kind (SW14). At most one active run a kind a month.
create table spread_runs (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  kind text not null check (kind in ('prepayment', 'income_in_advance', 'accrued_expense', 'accrued_income')),
  month date not null check (extract(day from month) = 1),
  total numeric(18, 2) not null,
  -- Null when the month had nothing in it for the kind: it still counts as done (SW14).
  journal_id bigint references ledger_journals(id),
  status text not null default 'active' check (status in ('active', 'undone')),
  undo_journal_id bigint references ledger_journals(id),
  undo_command_source text,
  undo_idempotency_key text,
  undo_request_hash text,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  undone_by_email text,
  undone_at timestamptz,
  unique (command_source, idempotency_key),
  unique (undo_command_source, undo_idempotency_key),
  check (undo_journal_id is null or status = 'undone')
);
create unique index spread_runs_one_active on spread_runs (kind, month) where status = 'active';

-- Something being spread: the amount, where it lands, and how.
create table spread_items (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  kind text not null check (kind in ('prepayment', 'income_in_advance', 'accrued_expense', 'accrued_income')),
  description text not null check (length(btrim(description)) between 1 and 200),
  contact_id bigint references contacts(id),
  -- The income or expense account each month's share lands on.
  target_account_id bigint not null references accounts(id),
  -- Without GST when GST was claimed or charged on it (SW1, SW9).
  amount numeric(18, 2) not null check (amount > 0),
  method text not null check (method in ('by_month', 'by_days', 'one_month', 'own_amounts', 'when_done')),
  start_date date,
  end_date date,
  check (end_date is null or start_date is null or end_date >= start_date),
  -- An accrual once its bill or invoice has arrived (SW6, SW7): the month, and the amount without GST.
  settled_month date check (settled_month is null or extract(day from settled_month) = 1),
  settled_amount numeric(18, 2) check (settled_amount is null or settled_amount > 0),
  check ((settled_month is null) = (settled_amount is null)),
  check (settled_month is null or kind in ('accrued_expense', 'accrued_income')),
  removed_at timestamptz,
  removed_by_email text,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create index spread_items_kind on spread_items (kind) where removed_at is null;

-- Each month's amount for an item. 'share' is its part of the amount;
-- 'difference' is what a late bill or invoice was over or under the
-- accrual (SW6), which can be negative. run_id is the journal it posted in.
create table spread_item_months (
  item_id bigint not null references spread_items(id),
  month date not null check (extract(day from month) = 1),
  line_kind text not null default 'share' check (line_kind in ('share', 'difference')),
  amount numeric(18, 2) not null,
  check (line_kind = 'difference' or amount >= 0),
  run_id bigint references spread_runs(id),
  primary key (item_id, month, line_kind)
);
create index spread_item_months_month on spread_item_months (month) where run_id is null;
create index spread_item_months_run on spread_item_months (run_id) where run_id is not null;

-- Journals Spreading posts are their own origin, so the ledger sends people back to the worksheet to undo them.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal',
                    'opening_balance', 'payroll', 'livestock_valuation', 'livestock_rations', 'recode', 'history', 'sales_when_sent',
                    'spreading'));
`,
  };
