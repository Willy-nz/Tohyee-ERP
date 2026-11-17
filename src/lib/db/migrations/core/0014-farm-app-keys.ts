import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0014",
    name: "farm_app_keys",
    sql: `
-- Keys for people's own farm apps (#249 stage 5; examples FA1-FA8, decision
-- 561). Like AI keys: one person, one organisation, only the SHA-256 kept,
-- revoked rather than deleted. Scopes say what the app may do; recording
-- also needs the owner's role (bookkeeper or higher) each time it's used.
create table farm_app_keys (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  organisation_id text not null references organisations(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null check (length(token_prefix) = 8),
  scopes text[] not null check (cardinality(scopes) between 1 and 5 and scopes <@ array['read_farm', 'read_soil', 'read_pasture', 'record_soil_samples', 'record_pasture']::text[]),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by_email text not null
);
create index farm_app_keys_owner_idx on farm_app_keys (organisation_id, user_id);
`,
  };
