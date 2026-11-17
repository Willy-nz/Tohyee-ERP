import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0026",
    name: "stock_transfers",
    sql: `
-- Stock transfers between locations (examples TR1-TR6). Stock leaves one
-- location at its weighted average cost and arrives at another at the same
-- value: two movements (transfer out, transfer in) and one journal that
-- moves the value between the locations on the inventory account (Dr tagged
-- with the location it goes to, Cr with the one it comes from). Transfers
-- are never changed or deleted; a transfer back undoes one.

create table stock_transfers (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  transfer_date date not null,
  item_id bigint not null references items(id),
  item_code text not null,
  from_location_value_id bigint not null references tracking_values(id),
  to_location_value_id bigint not null references tracking_values(id),
  quantity numeric not null check (quantity > 0 and scale(quantity) <= 4),
  value numeric not null check (value > 0),
  reference text not null check (length(reference) between 1 and 100),
  description text check (description is null or length(description) between 1 and 500),
  journal_id bigint not null unique references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (from_location_value_id <> to_location_value_id)
);
create trigger stock_transfers_append_only
  before update or delete on stock_transfers
  for each row execute function toeyee_forbid_mutation();
create trigger stock_transfers_no_truncate
  before truncate on stock_transfers
  for each statement execute function toeyee_forbid_mutation();

alter table inventory_movements drop constraint inventory_movements_movement_type_check;
alter table inventory_movements add constraint inventory_movements_movement_type_check check (
  movement_type in ('receipt', 'issue', 'adjustment', 'customer_return', 'supplier_return', 'landed_cost', 'reversal',
                    'transfer_out', 'transfer_in'));
alter table inventory_movements drop constraint inventory_movements_source_type_check;
alter table inventory_movements add constraint inventory_movements_source_type_check check (source_type is null or source_type in (
  'invoice', 'invoice_void', 'bill', 'bill_void', 'credit_note', 'credit_note_void',
  'supplier_credit_note', 'supplier_credit_note_void', 'transfer'));
-- A transfer's two movements name it (TR1).
alter table inventory_movements add constraint inventory_movements_transfer_check
  check ((movement_type in ('transfer_out', 'transfer_in')) = (source_type is not distinct from 'transfer'));
`,
  };
