import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0287",
    name: "analytics_merchant_center",
    sql: `
-- Google Merchant Center as an Analytics data source (#797, decision 1691,
-- examples GMC1-GMC8). Like Search Console (0210): one connection per
-- organisation, signed in through the organisation's own Google app asking
-- only for Merchant Center (the content scope; Tohyee only reads), tokens
-- encrypted with TOHYEE_SECRET_KEY. The data is only in the analytics copy
-- (google_merchant_center_* tables); disconnecting deletes this row and
-- those tables.
create table analytics_merchant_center_connections (
  id boolean primary key default true check (id),
  google_email text not null,
  refresh_token_ciphertext text not null,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  -- The Merchant Center account, once chosen.
  account_id text check (account_id is null or account_id ~ '^[0-9]{1,20}$'),
  account_name text check (account_name is null or length(account_name) <= 300),
  reload_daily boolean not null default true,
  needs_reconnect boolean not null default false,
  connected_by_email text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table analytics_google_states drop constraint if exists analytics_google_states_product_check;
alter table analytics_google_states add constraint analytics_google_states_product_check
  check (product in ('analytics', 'search_console', 'merchant_center'));
`,
  };
