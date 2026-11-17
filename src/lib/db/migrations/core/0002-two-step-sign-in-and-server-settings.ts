import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0002",
    name: "two_step_sign_in_and_server_settings",
    sql: `
-- Two-step sign-in (authenticator app, RFC 6238). The secret is encrypted with
-- the server's TOHYEE_SECRET_KEY. totp_last_step stops a code being used twice.
-- A pending secret is one shown as a QR code but not confirmed yet.
alter table users
  add column totp_secret_ciphertext text,
  add column totp_enabled_at timestamptz,
  add column totp_last_step bigint,
  add column totp_pending_ciphertext text,
  add column two_step_failed_count integer not null default 0,
  add constraint users_totp_enabled_check check ((totp_enabled_at is null) = (totp_secret_ciphertext is null));

-- One-use backup codes (scrypt hashes, like passwords).
create table user_backup_codes (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index user_backup_codes_user_idx on user_backup_codes (user_id) where used_at is null;

-- A session is "pending" between the password and the second step. Pending
-- sessions last 10 minutes and can only finish signing in.
alter table sessions
  add column two_step_pending boolean not null default false,
  add column two_step_failures integer not null default 0;

-- Emailed links for resetting two-step sign-in when the phone is lost.
create table two_step_reset_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- Server-wide settings set by server admins (email sending, remote access).
-- Passwords and tokens are encrypted with TOHYEE_SECRET_KEY and never sent to
-- the browser. No accounting data lives here.
create table server_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  value jsonb not null default '{}'::jsonb,
  secret_ciphertext text,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
`,
  };
