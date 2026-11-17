import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0169",
    name: "private_mail_ai_keys",
    sql: `
-- Which of an Owner's own AI keys may read their private mail copy (#250
-- part 2; PM15-PM19, decisions 618, 619). The key itself is in the core
-- database (ai_access_tokens); only its id is here, bound to the Owner who
-- gave it the scope. Only Look only keys can have it.
create table private_mail_ai_keys (
  token_id text primary key,
  owner_user_id uuid not null,
  granted_at timestamptz not null default now()
);
create index private_mail_ai_keys_owner on private_mail_ai_keys (owner_user_id);
`,
  };
