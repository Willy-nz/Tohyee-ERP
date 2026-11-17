import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0009",
    name: "user_setup_links",
    sql: `
-- One-time links for setting up a login (#208 item 2, Jess 9 Oct 2026): the
-- person chooses their own password and sets up two-step sign-in through it,
-- from anywhere. With two-step sign-in on, a password alone no longer starts
-- setting two-step up, so a stolen password can't register someone else's
-- authenticator. Only a hash of the link's code is kept.
create table user_setup_links (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references users(id) on delete cascade,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index user_setup_links_user on user_setup_links (user_id) where used_at is null;
`,
  };
