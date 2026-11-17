import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0274",
    name: "gateway_settlements",
    sql: `
-- A payment gateway's deposit (Afterpay, say) matched to the order payments
-- it settles in the gateway's clearing account (GS1-GS6, decision 1591): the
-- line is reconciled with a transfer from the clearing account, and the fee
-- is a spend from it. A payment is settled while that line stays reconciled.
create table gateway_settlements (
  id bigserial primary key,
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 200),
  statement_line_id bigint not null references bank_statement_lines(id),
  clearing_account_id bigint not null references accounts(id),
  method text not null check (length(method) between 1 and 100),
  settled numeric not null check (settled > 0),
  fee numeric not null check (fee >= 0),
  fee_transaction_id bigint references bank_transactions(id),
  created_by_email text,
  created_at timestamptz not null default now()
);
create table gateway_settlement_payments (
  settlement_id bigint not null references gateway_settlements(id),
  customer_payment_id bigint not null references customer_payments(id),
  primary key (settlement_id, customer_payment_id)
);
`,
  };
