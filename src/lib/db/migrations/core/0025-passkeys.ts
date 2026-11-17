import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0025",
    name: "passkeys",
    sql: `
-- Sign in with a passkey (#450, decisions 885-899): Face ID, a fingerprint
-- or Windows Hello. Tohyee keeps only each passkey's public key; the face or
-- finger never leaves the device.

-- The random ID a passkey carries for its login (WebAuthn's user handle), so
-- a passkey sign-in can check the passkey is the login's. Not the login's own
-- ID or email: it says nothing about the person. Made when the first passkey
-- is added.
alter table users add column passkey_user_handle text unique check (passkey_user_handle ~ '^[A-Za-z0-9_-]{16,128}$');

-- One row per passkey. Only for the address it was made on (rp_id: Tohyee's
-- web address, or localhost on the server computer).
create table user_passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  credential_id text not null unique check (credential_id ~ '^[A-Za-z0-9_-]+$' and length(credential_id) between 16 and 1400),
  public_key bytea not null check (length(public_key) between 16 and 4096),
  sign_count bigint not null default 0 check (sign_count >= 0),
  transports text[] not null default '{}',
  rp_id text not null check (length(rp_id) between 1 and 253),
  device_type text not null check (device_type in ('singleDevice', 'multiDevice')),
  backed_up boolean not null default false,
  aaguid text check (aaguid is null or length(aaguid) <= 64),
  name text not null check (length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index user_passkeys_user_id_idx on user_passkeys (user_id);

-- Each challenge is random, used once, within 5 minutes, and only from the
-- browser (sign-in) or the session (adding a passkey) that asked for it. Only
-- its hash is kept.
create table passkey_challenges (
  challenge_hash text primary key check (challenge_hash ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose in ('sign_in', 'register')),
  browser_hash text check (browser_hash is null or browser_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid references users(id) on delete cascade,
  session_id text check (session_id is null or session_id ~ '^[0-9a-f]{64}$'),
  rp_id text not null check (length(rp_id) between 1 and 253),
  origin text not null check (length(origin) <= 300),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  check ((purpose = 'sign_in') = (browser_hash is not null)),
  check ((purpose = 'register') = (user_id is not null and session_id is not null))
);
create index passkey_challenges_created on passkey_challenges (created_at);

-- A passkey sign-in counts as two-step. The session remembers which passkey,
-- so removing the passkey ends the sessions it signed in.
alter table sessions drop constraint sessions_sign_in_method_check;
alter table sessions add constraint sessions_sign_in_method_check check (sign_in_method in ('password', 'google', 'passkey'));
alter table sessions add column passkey_id uuid references user_passkeys(id) on delete cascade;
create index sessions_passkey_id_idx on sessions (passkey_id) where passkey_id is not null;

alter table sign_in_events drop constraint sign_in_events_step_check;
alter table sign_in_events add constraint sign_in_events_step_check
  check (step in ('password', 'code', 'backup_code', 'setup_link', 'reset_link', 'first_admin', 'google', 'passkey'));
`,
  };
