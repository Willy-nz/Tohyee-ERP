import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0289",
    name: "analytics_business_profile_google_ads",
    sql: `
-- Google Business Profile and Google Ads as Analytics data sources (#797,
-- decisions 1693-1694, examples GBP1-GBP7 and GADS1-GADS7). Like Merchant
-- Center (0287): one connection each per organisation, signed in through
-- the organisation's own Google app, tokens encrypted with
-- TOHYEE_SECRET_KEY. The data is only in the analytics copy
-- (google_business_profile_* and google_ads_* tables); disconnecting
-- deletes the row and those tables.
create table analytics_business_profile_connections (
  id boolean primary key default true check (id),
  google_email text not null,
  refresh_token_ciphertext text not null,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  -- The profile, once chosen: Google's account and location names.
  account_name text check (account_name is null or account_name ~ '^accounts/[0-9]{1,30}$'),
  location_name text check (location_name is null or location_name ~ '^locations/[0-9]{1,30}$'),
  location_title text check (location_title is null or length(location_title) <= 300),
  reload_daily boolean not null default true,
  needs_reconnect boolean not null default false,
  connected_by_email text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((account_name is null) = (location_name is null))
);

create table analytics_google_ads_connections (
  id boolean primary key default true check (id),
  google_email text not null,
  refresh_token_ciphertext text not null,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  -- The Google Ads account (customer), once chosen, and the manager
  -- account it's reached through, if any.
  customer_id text check (customer_id is null or customer_id ~ '^[0-9]{10}$'),
  customer_name text check (customer_name is null or length(customer_name) <= 300),
  login_customer_id text check (login_customer_id is null or login_customer_id ~ '^[0-9]{10}$'),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  reload_daily boolean not null default true,
  needs_reconnect boolean not null default false,
  connected_by_email text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table analytics_google_states drop constraint if exists analytics_google_states_product_check;
alter table analytics_google_states add constraint analytics_google_states_product_check
  check (product in ('analytics', 'search_console', 'merchant_center', 'business_profile', 'google_ads'));
`,
  };
