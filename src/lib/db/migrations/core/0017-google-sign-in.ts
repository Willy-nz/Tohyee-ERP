import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0017",
    name: "google_sign_in",
    sql: `
-- Sign in with Google for invited people (#424, decisions 800-809). A login
-- is linked to one Google account by Google's own account ID ("sub"), never
-- by email address alone, so a changed or reused Gmail address can't move it
-- to someone else. The address is kept only to show which account it is.
create table user_google_identities (
  user_id uuid primary key references users(id) on delete cascade,
  google_sub text not null check (google_sub ~ '^[A-Za-z0-9._-]{1,255}$'),
  email text not null check (length(email) <= 254),
  linked_at timestamptz not null default now(),
  last_used_at timestamptz
);
create unique index user_google_identities_sub on user_google_identities (google_sub);

-- A login set up with Google from its setup link has no password anyone
-- knows. Server admins always keep a password (checked in code).
alter table users add column google_only boolean not null default false;

-- How a session was signed in: a Google sign-in relies on Google's own
-- checks and doesn't ask for Tohyee's authenticator code.
alter table sessions add column sign_in_method text not null default 'password' check (sign_in_method in ('password', 'google'));

-- One row per trip to Google's sign-in page: only hashes of the state and of
-- the browser's cookie are kept; the PKCE verifier and nonce are random and
-- used once, within 10 minutes.
create table google_sign_in_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  browser_hash text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose in ('sign_in', 'setup', 'link')),
  code_verifier text not null check (length(code_verifier) between 43 and 128),
  nonce text not null check (length(nonce) between 16 and 128),
  redirect_uri text not null check (length(redirect_uri) <= 500),
  next_path text check (next_path is null or length(next_path) <= 200),
  user_id uuid references users(id) on delete cascade,
  session_id text check (session_id is null or session_id ~ '^[0-9a-f]{64}$'),
  setup_token_hash text check (setup_token_hash is null or setup_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  check ((purpose = 'link') = (user_id is not null and session_id is not null)),
  check ((purpose = 'setup') = (setup_token_hash is not null))
);
create index google_sign_in_states_created on google_sign_in_states (created_at);

alter table sign_in_events drop constraint sign_in_events_step_check;
alter table sign_in_events add constraint sign_in_events_step_check
  check (step in ('password', 'code', 'backup_code', 'setup_link', 'reset_link', 'first_admin', 'google'));
`,
  };
