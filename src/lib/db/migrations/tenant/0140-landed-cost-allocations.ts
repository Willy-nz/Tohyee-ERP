import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0140",
    name: "landed_cost_allocations",
    sql: `
-- Landed cost spread across a bill's stock (#259, examples LDC1-LDC5):
-- freight, duty or insurance, split by value or quantity. The share of stock
-- still on hand goes onto the stock (landed_cost movements); the share
-- already sold goes to cost of sales.
create table landed_cost_allocations (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  bill_id bigint not null references bills(id),
  allocation_date date not null,
  amount numeric(18, 2) not null check (amount > 0),
  method text not null check (method in ('value', 'quantity')),
  offset_account_id bigint not null references accounts(id),
  reference text not null check (length(reference) between 1 and 100),
  cost_of_sales_journal_id bigint references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create index landed_cost_allocations_bill on landed_cost_allocations (bill_id);

create table landed_cost_allocation_lines (
  id bigserial primary key,
  allocation_id bigint not null references landed_cost_allocations(id),
  item_code text not null,
  location_value_id bigint,
  received_quantity numeric(18, 4) not null,
  received_value numeric(18, 2) not null,
  share numeric(18, 2) not null,
  to_stock numeric(18, 2) not null,
  to_cost_of_sales numeric(18, 2) not null,
  inventory_movement_id bigint references inventory_movements(id),
  check (share = to_stock + to_cost_of_sales)
);

create trigger landed_cost_allocations_no_change before update or delete on landed_cost_allocations for each row execute function toeyee_forbid_delete();
create trigger landed_cost_allocation_lines_no_change before update or delete on landed_cost_allocation_lines for each row execute function toeyee_forbid_delete();
`,
  };
