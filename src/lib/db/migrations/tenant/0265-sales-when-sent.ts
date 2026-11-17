import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0265",
    name: "sales_when_sent",
    sql: `
-- Shopify sales when sent (SWS1-SWS9, decision 1569). A connection's
-- Income in advance account: set, orders brought in hold what's still to be
-- sent there until Shopify records it as sent.
alter table sales_platform_connections add column sales_when_sent_account_id bigint references accounts(id);
-- An order brought in while it was on.
alter table sales_platform_documents add column sales_when_sent boolean not null default false;

-- What an order holds, line by line (shipping too): its net amount, how much
-- has been sent or refunded, and what's moved out of Income in advance.
create table sales_platform_held_lines (
  id bigserial primary key,
  connection_id bigint not null references sales_platform_connections(id),
  order_external_id text not null check (length(order_external_id) between 1 and 100),
  line_kind text not null check (line_kind in ('line', 'shipping')),
  line_external_id text not null check (length(line_external_id) between 1 and 100),
  description text not null check (length(description) between 1 and 500),
  item_id bigint references items(id),
  income_account_id bigint not null references accounts(id),
  -- Where it's held (the setting can change or be turned off while it's held).
  held_account_id bigint not null references accounts(id),
  quantity numeric(18, 6) not null check (quantity > 0),
  amount numeric(18, 2) not null,
  sent_quantity numeric(18, 6) not null default 0 check (sent_quantity >= 0),
  refunded_quantity numeric(18, 6) not null default 0 check (refunded_quantity >= 0),
  -- Moved to sales when sent, or out by a refund (SWS2-SWS7).
  recognised_amount numeric(18, 2) not null default 0,
  refunded_amount numeric(18, 2) not null default 0,
  closed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, order_external_id, line_kind, line_external_id)
);
create index sales_platform_held_lines_open_idx on sales_platform_held_lines (connection_id, order_external_id) where not closed;

-- Each fulfilment counted once (SWS8), with the journal it posted.
create table sales_platform_sent (
  id bigserial primary key,
  connection_id bigint not null references sales_platform_connections(id),
  order_external_id text not null check (length(order_external_id) between 1 and 100),
  fulfilment_external_id text not null check (length(fulfilment_external_id) between 1 and 100),
  sent_on date not null,
  journal_id bigint references ledger_journals(id),
  created_at timestamptz not null default now(),
  unique (connection_id, fulfilment_external_id)
);

alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal',
                    'opening_balance', 'payroll', 'livestock_valuation', 'livestock_rations', 'recode', 'history', 'sales_when_sent'));
`,
  };
