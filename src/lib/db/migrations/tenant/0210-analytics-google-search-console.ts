import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0210",
    name: "analytics_google_search_console",
    sql: `
-- A website's Google Search Console data in Analytics (#512, decisions
-- 1180-1189, examples GSC1-GSC9). Like Google Analytics (0167): one
-- connection per organisation, signed in through the organisation's own
-- Google app asking only to read Search Console (webmasters.readonly),
-- tokens encrypted with TOHYEE_SECRET_KEY. The data is only in the
-- analytics copy (google_search_console_* tables); disconnecting deletes
-- this row and those tables.
create table analytics_search_console_connections (
  id boolean primary key default true check (id),
  google_email text not null,
  refresh_token_ciphertext text not null,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  -- The Search Console property, once chosen: a URL-prefix property
  -- ("https://www.example.com/") or a domain property ("sc-domain:example.com").
  site_url text check (site_url is null or (length(site_url) <= 2048 and (site_url ~ '^https?://' or site_url ~ '^sc-domain:'))),
  -- What Google said this account can do with it (siteOwner, siteFullUser, siteRestrictedUser).
  permission_level text,
  search_type text not null default 'web' check (search_type in ('web', 'image', 'video', 'news')),
  reload_daily boolean not null default true,
  needs_reconnect boolean not null default false,
  -- What's loaded (Google's days, Pacific time): the first and last day,
  -- and the first day that may still change, fetched again next time.
  loaded_from date,
  loaded_through date,
  changing_from date,
  connected_by_email text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((loaded_from is null) = (loaded_through is null)),
  check (loaded_from is null or loaded_from <= loaded_through),
  check (changing_from is null or loaded_through is not null)
);

-- Google sign-ins share one return address (/api/analytics/google/callback),
-- so each one-time state says which connection it's for.
alter table analytics_google_states add column product text not null default 'analytics'
  check (product in ('analytics', 'search_console'));
`,
  };
