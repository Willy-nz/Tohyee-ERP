import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0005",
    name: "ai_access_tokens",
    sql: `
-- Personal keys for connecting someone's own AI (Claude, ChatGPT and others)
-- to one organisation's books over MCP (decisions 339-348). Each key has an
-- access level chosen when it's made (read, draft or post), capped by its
-- owner's role when it's used; no level deletes anything. Only the SHA-256
-- of the key is kept; the key itself is shown once when it's made. Revoked,
-- never deleted, so the list shows what was made and when.
create table ai_access_tokens (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  organisation_id text not null references organisations(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null check (length(token_prefix) = 8),
  access_level text not null default 'read' check (access_level in ('read', 'draft', 'post')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by_email text not null
);
create index ai_access_tokens_owner_idx on ai_access_tokens (organisation_id, user_id);
`,
  };
