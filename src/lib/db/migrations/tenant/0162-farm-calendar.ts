import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0162",
    name: "farm_calendar",
    sql: `
-- The farm calendar from email (#319; examples FC1-FC16, decisions 570-572).
-- A member's own mailbox, read-only, and what Tohyee read from it: only that
-- member can see or change any of it. Disconnecting deletes it all.
create table farm_mail_accounts (
  id bigserial primary key,
  user_id uuid not null,
  provider text not null check (provider in ('google', 'microsoft')),
  email text not null,
  refresh_token_ciphertext text not null,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  history_days integer not null check (history_days between 30 and 365),
  history_from timestamptz not null,
  -- Newer mail is read from here (less an hour); older history before
  -- backfill_before is still to read until it's null.
  checked_through timestamptz not null,
  backfill_before timestamptz,
  default_farm_id bigint references farms(id),
  status text not null default 'active' check (status in ('active', 'paused')),
  failures integer not null default 0,
  last_error text,
  last_check_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index farm_mail_accounts_mailbox on farm_mail_accounts (provider, lower(email));
create index farm_mail_accounts_user on farm_mail_accounts (user_id);

create table farm_mail_states (
  state text primary key,
  user_id uuid not null,
  provider text not null check (provider in ('google', 'microsoft')),
  history_days integer not null check (history_days between 30 and 365),
  default_farm_id bigint references farms(id),
  created_at timestamptz not null default now(),
  used_at timestamptz
);

-- Each email read once (FC9): only its id and date, never its content.
create table farm_mail_seen (
  account_id bigint not null references farm_mail_accounts(id) on delete cascade,
  external_id text not null,
  sent_at timestamptz not null,
  primary key (account_id, external_id)
);

create table farm_calendar_items (
  id bigserial primary key,
  account_id bigint not null references farm_mail_accounts(id) on delete cascade,
  external_id text not null,
  thread_id text,
  sent_at timestamptz not null,
  sender_email text not null,
  sender_name text,
  subject text,
  web_link text,
  kind text not null check (kind in ('animal_health', 'delivery', 'stock_movement', 'contractor', 'deadline', 'meeting')),
  title text not null check (length(title) between 1 and 200),
  item_date date,
  start_time time,
  end_time time,
  tentative boolean not null default false,
  change text not null default 'new' check (change in ('new', 'moved', 'cancelled')),
  check_reasons text[] not null default '{}',
  farm_id bigint references farms(id),
  excerpt text not null,
  state text not null default 'open' check (state in ('open', 'moved', 'cancelled', 'dismissed')),
  state_note text,
  replaced_by bigint references farm_calendar_items(id) on delete set null,
  also_seen integer not null default 0,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index farm_calendar_items_account_date on farm_calendar_items (account_id, item_date);
`,
  };
