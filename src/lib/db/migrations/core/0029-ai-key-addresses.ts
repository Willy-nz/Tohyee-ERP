import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0029",
    name: "ai_key_addresses",
    sql: `
-- Where an AI key or connected app was used from (#695, decision 1668):
-- the latest address on the key itself, for the AI page, and the addresses
-- it has been used from, so a Full access key's owner can be emailed when a
-- new one turns up (at most once a day per key).
alter table ai_access_tokens add column last_used_from text check (length(last_used_from) <= 100);
alter table ai_access_tokens add column new_address_emailed_at timestamptz;
create table ai_token_addresses (
  token_id bigint not null references ai_access_tokens(id) on delete cascade,
  address text not null check (length(address) between 1 and 100),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (token_id, address)
);
`,
  };
