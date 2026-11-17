import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0061",
    name: "sales_platform_orders",
    sql: `
-- Sales platform connections, stage 2 (examples SPC11-SPC23, decisions
-- 51-55): Shopify orders, payments, refunds and payouts into the accounts.
-- The connection's posting settings, which Tohyee tax code each Shopify tax
-- rate is, and which Tohyee documents each Shopify order, refund and payout
-- became. Versions 0051-0060 are taken or reserved by other branches.
alter table sales_platform_connections
  add column post_to_accounts boolean not null default false,
  add column start_date date,
  add column clearing_account_id bigint references accounts(id),
  add column payout_account_id bigint references accounts(id),
  add column fees_account_id bigint references accounts(id),
  add column sales_account_id bigint references accounts(id),
  add column shipping_account_id bigint references accounts(id),
  add column untaxed_tax_code_id bigint references tax_codes(id),
  -- The access scopes the store gave the app, as it last said.
  add column granted_scopes text[] not null default '{}',
  add column orders_synced_until timestamptz,
  add column payouts_synced_until timestamptz,
  add constraint sales_platform_connections_posting_check check (
    not post_to_accounts or (start_date is not null and clearing_account_id is not null and payout_account_id is not null
      and fees_account_id is not null and sales_account_id is not null and shipping_account_id is not null)
  );

-- Shopify's tax rate (as a fraction, 0.15) -> Tohyee's tax code.
create table sales_platform_tax_codes (
  connection_id bigint not null references sales_platform_connections(id),
  rate numeric(9, 6) not null check (rate > 0 and rate < 1),
  tax_code_id bigint not null references tax_codes(id),
  primary key (connection_id, rate)
);

-- Which Tohyee documents each platform order, refund and payout became.
-- Keyed by the store rather than the connection and kept after
-- disconnecting, so connecting the store again never brings an order in
-- twice.
create table sales_platform_documents (
  id bigserial primary key,
  platform text not null check (platform in ('shopify')),
  store_domain text not null check (store_domain = lower(store_domain) and length(store_domain) between 1 and 255),
  record_kind text not null check (record_kind in ('order', 'refund', 'payout')),
  external_id text not null check (length(external_id) between 1 and 100),
  -- A refund's order.
  order_external_id text check (order_external_id is null or length(order_external_id) <= 100),
  connection_id bigint not null references sales_platform_connections(id),
  name text check (name is null or length(name) <= 100),
  state text not null check (state in ('open', 'done', 'cancelled')),
  -- Something stopped it part way (e.g. a locked period): the catch-up sync tries again.
  retry boolean not null default false,
  contact_id bigint references contacts(id),
  sales_order_id bigint references sales_orders(id),
  invoice_id bigint references sales_invoices(id),
  customer_payment_id bigint references customer_payments(id),
  credit_note_id bigint references sales_credit_notes(id),
  credit_note_refund_id bigint references sales_credit_note_refunds(id),
  transfer_id bigint references bank_transfers(id),
  bank_transaction_id bigint references bank_transactions(id),
  external_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((record_kind = 'refund') = (order_external_id is not null)),
  unique (platform, store_domain, record_kind, external_id)
);
create index sales_platform_documents_retry_idx on sales_platform_documents (connection_id) where retry;

-- The sync log names the documents posted, and orders, refunds and payouts.
alter table sales_platform_sync_log drop constraint sales_platform_sync_log_action_check;
alter table sales_platform_sync_log add constraint sales_platform_sync_log_action_check check (action in (
  'connected', 'tested', 'settings', 'webhooks', 'disconnected', 'sync',
  'created', 'linked', 'updated', 'kept', 'skipped', 'failed', 'posted', 'cancelled', 'waiting'));
alter table sales_platform_sync_log drop constraint sales_platform_sync_log_record_kind_check;
alter table sales_platform_sync_log add constraint sales_platform_sync_log_record_kind_check check (
  record_kind is null or record_kind in ('customer', 'product_variant', 'order', 'refund', 'payout'));
alter table sales_platform_sync_log
  add column document_type text check (document_type is null or document_type in (
    'sales_order', 'invoice', 'customer_payment', 'credit_note', 'credit_note_refund', 'transfer', 'bank_transaction')),
  add column document_id bigint,
  add constraint sales_platform_sync_log_document_check check ((document_type is null) = (document_id is null));
`,
  };
