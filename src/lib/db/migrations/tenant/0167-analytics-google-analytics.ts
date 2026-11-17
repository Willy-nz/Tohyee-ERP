import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0167",
    name: "analytics_google_analytics",
    sql: `
-- A website's Google Analytics (GA4) data in Analytics (decisions 606-609,
-- examples GA1-GA8). One connection per organisation: the Google sign-in
-- an admin made (tokens encrypted with TOHYEE_SECRET_KEY), the property
-- chosen, and how much history is loaded. The data itself is only in the
-- analytics copy (google_analytics_* tables); disconnecting deletes this
-- row and those tables.
create table analytics_google_connections (
  id boolean primary key default true check (id),
  google_email text not null,
  refresh_token_ciphertext text not null,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  -- GA4 property, e.g. 123456789 (properties/123456789), once chosen.
  property_id text check (property_id is null or property_id ~ '^[0-9]{1,20}$'),
  property_name text,
  account_name text,
  -- As Google said at the last load: revenue's currency and the property's time zone.
  currency_code text,
  time_zone text,
  history_months integer not null default 13 check (history_months between 1 and 60),
  reload_daily boolean not null default true,
  -- Google refused the sign-in (expired or withdrawn): nothing loads until it's connected again.
  needs_reconnect boolean not null default false,
  connected_by_email text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One-time sign-in states, tied to the admin who started connecting.
create table analytics_google_states (
  state text primary key,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
`,
  };
