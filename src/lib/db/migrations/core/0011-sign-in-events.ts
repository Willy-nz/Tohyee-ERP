import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0011",
    name: "sign_in_events",
    sql: `
-- The sign-in monitor (#208 item 1, Jess 9 Oct 2026: no country lookup;
-- suspicious sign-ins are reported, not blocked). Every sign-in attempt, with
-- the address a proxy saw, the browser, whether it came through remote
-- access, and why it was flagged, if it was. Kept for a year.
create table sign_in_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  email text not null check (length(email) <= 254),
  user_id uuid references users(id) on delete set null,
  step text not null check (step in ('password', 'code', 'backup_code', 'setup_link', 'reset_link', 'first_admin')),
  outcome text not null check (outcome in ('signed_in', 'password_ok', 'failed', 'locked', 'refused')),
  detail text check (detail is null or length(detail) <= 300),
  address text check (address is null or length(address) <= 100),
  user_agent text check (user_agent is null or length(user_agent) <= 500),
  remote boolean not null default false,
  flag text check (flag is null or length(flag) <= 300)
);
create index sign_in_events_at on sign_in_events (at);
create index sign_in_events_user on sign_in_events (user_id, at);
create index sign_in_events_email on sign_in_events (email, at);
create index sign_in_events_address on sign_in_events (address, at);
create index sign_in_events_flagged on sign_in_events (at) where flag is not null;
`,
  };
