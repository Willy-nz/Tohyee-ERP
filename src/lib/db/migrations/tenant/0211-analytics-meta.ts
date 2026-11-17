import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0211",
    name: "analytics_meta",
    sql: `
-- Meta (a Facebook Page, its Instagram professional account and, if
-- chosen, an ad account) as an Analytics data source (#516, decisions
-- 1190-1209, examples META1-META10). Built like Google Search Console
-- (0210): one connection per organisation, read-only, tokens encrypted
-- with TOHYEE_SECRET_KEY, the data only in the analytics copy (meta_*
-- tables); disconnecting deletes the connection and those tables.

-- The organisation's own Meta app (developers.facebook.com), entered by an
-- admin. The secret is encrypted and never shown again. A configuration ID
-- is Facebook Login for Business' list of permissions; without one Tohyee
-- names the permissions itself.
create table analytics_meta_apps (
  id boolean primary key default true check (id),
  app_id text not null check (app_id ~ '^[0-9]{5,20}$'),
  app_secret_ciphertext text not null,
  config_id text check (config_id is null or config_id ~ '^[0-9]{5,20}$'),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

create table analytics_meta_connections (
  id boolean primary key default true check (id),
  facebook_user_id text not null,
  facebook_user_name text,
  -- The long-lived user token (about 60 days; Meta has no refresh for it).
  -- Lists Pages and ad accounts, and reads ads.
  user_token_ciphertext text not null,
  user_token_expires_at timestamptz,
  data_access_expires_at timestamptz,
  granted_permissions text not null default '',
  declined_permissions text not null default '',
  -- The Page, once chosen, with its own token (no fixed expiry when made
  -- from a long-lived user token). Reads the Page and its Instagram account.
  page_id text check (page_id is null or page_id ~ '^[0-9]{1,30}$'),
  page_name text,
  page_token_ciphertext text,
  instagram_id text check (instagram_id is null or instagram_id ~ '^[0-9]{1,30}$'),
  instagram_username text,
  ad_account_id text check (ad_account_id is null or ad_account_id ~ '^act_[0-9]{1,30}$'),
  ad_account_name text,
  ad_currency text,
  ad_time_zone text,
  reload_daily boolean not null default true,
  -- Meta refused the sign-in (expired, password changed, app removed):
  -- nothing loads until an admin connects again. The reason in plain words.
  needs_reconnect boolean not null default false,
  reconnect_reason text,
  -- The last day loaded for each part (Meta's days are Pacific time; ads
  -- are in the ad account's time zone). Days from a little before are
  -- fetched again each load.
  facebook_loaded_through date,
  instagram_loaded_through date,
  ads_loaded_through date,
  connected_by_email text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((page_id is null) = (page_token_ciphertext is null)),
  check (instagram_id is null or page_id is not null)
);

-- One-time sign-in states, tied to the admin who started connecting, and
-- whether they asked to read ads too.
create table analytics_meta_states (
  state text primary key,
  user_id uuid not null,
  with_ads boolean not null default false,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
`,
  };
