import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0105",
    name: "woocommerce_orders",
    sql: `
-- WooCommerce orders into the accounts (item 7 part 2, examples WC1-WC10,
-- decisions 451-455): WooCommerce as a second platform, which needs no
-- clearing, payout or fees account (it has no payouts), and where each
-- payment method's money goes.
alter table sales_platform_connections drop constraint sales_platform_connections_platform_check;
alter table sales_platform_connections add constraint sales_platform_connections_platform_check check (platform in ('shopify', 'woocommerce'));
alter table sales_platform_documents drop constraint sales_platform_documents_platform_check;
alter table sales_platform_documents add constraint sales_platform_documents_platform_check check (platform in ('shopify', 'woocommerce'));
alter table sales_platform_connections drop constraint sales_platform_connections_posting_check;
alter table sales_platform_connections add constraint sales_platform_connections_posting_check check (
  not post_to_accounts or (start_date is not null and sales_account_id is not null and shipping_account_id is not null
    and (platform = 'woocommerce' or (clearing_account_id is not null and payout_account_id is not null and fees_account_id is not null)))
);

-- Each payment method seen on the store's orders: the bank account its
-- money is recorded into, or left owing (bank transfer, cheque) for the
-- bank feed to match; neither until an admin chooses (WC8).
create table sales_platform_payment_methods (
  connection_id bigint not null references sales_platform_connections(id),
  method text not null check (length(method) between 1 and 100),
  title text check (title is null or length(title) <= 200),
  account_id bigint references accounts(id),
  left_owing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_id, method),
  check (not (left_owing and account_id is not null))
);
`,
  };
