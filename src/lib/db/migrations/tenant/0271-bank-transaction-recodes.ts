import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0271",
    name: "bank_transaction_recodes",
    sql: `
-- Bank transactions recoded in place (RC3, decision 1587): the one voided
-- and the one posted in its place. Bank transactions can't be changed, so
-- the link is kept here.
create table bank_transaction_recodes (
  from_id bigint primary key references bank_transactions(id),
  to_id bigint not null unique references bank_transactions(id),
  command_source text not null,
  idempotency_key text not null,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key, from_id)
);
`,
  };
