import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0219",
    name: "sales_platform_payouts",
    sql: `
-- Platform payouts as the store described them (#548, examples SPR1-SPR10,
-- decisions 1300-1307), so a bank deposit can be matched to its payout and
-- its settlement (gross sales, refunds, fees, adjustments, chargebacks,
-- reserves) shown without calling the store. Kept by store, like
-- sales_platform_documents, so reconnecting doesn't lose them. Nothing here
-- is posted: what each payout became is still sales_platform_documents.
-- detail_read is false when only the payout's total was read (a payout
-- posted before this table existed, or one not paid yet); the settlement
-- columns are then null.
create table sales_platform_payouts (
  platform text not null check (length(platform) between 1 and 30),
  store_domain text not null check (store_domain = lower(store_domain) and length(store_domain) between 1 and 255),
  external_id text not null check (length(external_id) between 1 and 100),
  connection_id bigint not null references sales_platform_connections(id),
  issued_on date not null,
  status text not null check (length(status) between 1 and 30),
  direction text not null check (length(direction) between 1 and 30),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  net numeric not null check (scale(net) <= 2),
  detail_read boolean not null default false,
  gross_sales numeric check (gross_sales is null or scale(gross_sales) <= 2),
  refunds numeric check (refunds is null or scale(refunds) <= 2),
  fees numeric check (fees is null or scale(fees) <= 2),
  adjustments numeric check (adjustments is null or scale(adjustments) <= 2),
  chargebacks numeric check (chargebacks is null or scale(chargebacks) <= 2),
  reserves numeric check (reserves is null or scale(reserves) <= 2),
  other_amounts numeric check (other_amounts is null or scale(other_amounts) <= 2),
  transaction_count integer check (transaction_count is null or transaction_count >= 0),
  incomplete boolean not null default false,
  -- The orders (by name, "#1001") whose charges are in the payout.
  order_names text[] not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (platform, store_domain, external_id),
  check (detail_read = (gross_sales is not null and refunds is not null and fees is not null and adjustments is not null
    and chargebacks is not null and reserves is not null and other_amounts is not null and transaction_count is not null))
);
create index sales_platform_payouts_connection_issued_idx on sales_platform_payouts (connection_id, issued_on);
`,
  };
