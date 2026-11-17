import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0018",
    name: "ai_connections_oauth",
    sql: `
-- AI apps that connect by signing in (#427, decisions 810-829): Claude.ai,
-- ChatGPT and other MCP clients sign in to Tohyee with OAuth 2.1, as the MCP
-- authorisation specification says, instead of being given a key. A
-- connection is a row in ai_access_tokens (kind 'connection') so it has the
-- same level, role ceiling, history name, private-mail scope and endings as
-- a key; it just has no key of its own. Only hashes of codes and tokens are
-- kept.

-- The AI apps Tohyee knows: ones that registered themselves (RFC 7591) and
-- ones whose details were read from their own https address (a client ID
-- metadata document), kept for a while.
create table oauth_clients (
  client_id text primary key check (length(client_id) between 1 and 500),
  source text not null check (source in ('registered', 'metadata_document')),
  client_name text not null check (length(client_name) between 1 and 100),
  redirect_uris jsonb not null check (jsonb_typeof(redirect_uris) = 'array'),
  created_at timestamptz not null default now(),
  fetched_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  check ((source = 'metadata_document') = (fetched_at is not null and expires_at is not null))
);
create index oauth_clients_unused on oauth_clients (created_at) where last_used_at is null;

alter table ai_access_tokens add column kind text not null default 'key' check (kind in ('key', 'connection'));
alter table ai_access_tokens alter column token_hash drop not null;
alter table ai_access_tokens alter column token_prefix drop not null;
alter table ai_access_tokens add column oauth_client_id text check (oauth_client_id is null or length(oauth_client_id) <= 500);
alter table ai_access_tokens add column redirect_uri text check (redirect_uri is null or length(redirect_uri) <= 500);
alter table ai_access_tokens add column resource text check (resource is null or length(resource) <= 500);
alter table ai_access_tokens add constraint ai_access_tokens_kind_shape check (
  (kind = 'key' and token_hash is not null and token_prefix is not null and oauth_client_id is null and redirect_uri is null and resource is null)
  or (kind = 'connection' and token_hash is null and token_prefix is null and oauth_client_id is not null and redirect_uri is not null and resource is not null)
);

-- One row per sign-in an AI app starts: what it asked for, tied to the
-- browser that started it by the hash of a random cookie. Used once, within
-- 10 minutes.
create table oauth_authorization_requests (
  handle_hash text primary key check (handle_hash ~ '^[0-9a-f]{64}$'),
  browser_hash text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  client_id text not null check (length(client_id) <= 500),
  client_name text not null check (length(client_name) between 1 and 100),
  redirect_uri text not null check (length(redirect_uri) <= 500),
  state text check (state is null or length(state) <= 500),
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9._~-]{43,128}$'),
  resource text not null check (length(resource) <= 500),
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index oauth_authorization_requests_created on oauth_authorization_requests (created_at);

-- The one-time code handed back to the app after the person allows it,
-- with what they chose. Used once, within 5 minutes, with the PKCE verifier.
create table oauth_authorization_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references users(id) on delete cascade,
  organisation_id text not null references organisations(id) on delete cascade,
  client_id text not null check (length(client_id) <= 500),
  client_name text not null check (length(client_name) between 1 and 100),
  redirect_uri text not null check (length(redirect_uri) <= 500),
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9._~-]{43,128}$'),
  resource text not null check (length(resource) <= 500),
  access_level text not null check (access_level in ('read', 'draft', 'post', 'full')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  connection_id bigint references ai_access_tokens(id) on delete cascade
);
create index oauth_authorization_codes_user on oauth_authorization_codes (user_id);
create index oauth_authorization_codes_created on oauth_authorization_codes (created_at);

-- Access tokens (an hour) and refresh tokens (60 days, replaced each time
-- they're used) for a connection. A refresh token used twice ends the
-- connection.
create table oauth_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  connection_id bigint not null references ai_access_tokens(id) on delete cascade,
  kind text not null check (kind in ('access', 'refresh')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index oauth_tokens_connection on oauth_tokens (connection_id);
`,
  };
