import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0023",
    name: "stock_tracking",
    sql: `
-- Stock tracking (examples ST1-ST12): weighted average per item and
-- location. A location is a value of the Location tracking category; with
-- none, an item has one default pool (location null). Stock items on bills,
-- invoices and credit notes move stock in the same transaction as their
-- journal. Stock can go below zero only while the organisation allows it.

alter table organisation_settings add column allow_negative_stock boolean not null default false;

-- Balances: one per item code and location.
alter table inventory_item_balances drop constraint inventory_item_balances_pkey;
alter table inventory_item_balances drop constraint if exists inventory_item_balances_on_hand_quantity_check;
alter table inventory_item_balances drop constraint if exists inventory_item_balances_carrying_value_check;
alter table inventory_item_balances
  add column id bigserial primary key,
  add column location_value_id bigint references tracking_values(id),
  add constraint inventory_item_balances_key unique nulls not distinct (item_code, location_value_id),
  add constraint inventory_item_balances_zero_check check (on_hand_quantity <> 0 or carrying_value = 0);

alter table inventory_movements drop constraint if exists inventory_movements_quantity_after_check;
alter table inventory_movements drop constraint if exists inventory_movements_value_after_check;
alter table inventory_movements drop constraint if exists inventory_movements_movement_type_check;
alter table inventory_movements
  add constraint inventory_movements_movement_type_check check (
    movement_type in ('receipt', 'issue', 'adjustment', 'customer_return', 'supplier_return', 'landed_cost', 'reversal')
  ),
  add column item_id bigint references items(id),
  add column location_value_id bigint references tracking_values(id),
  -- ST10: a receipt into negative stock; what the filled units cost less
  -- the value they went out at, posted to cost of sales.
  add column cost_adjustment numeric not null default 0,
  -- The document that moved the stock (null for movements entered directly).
  add column source_type text check (source_type is null or source_type in (
    'invoice', 'invoice_void', 'bill', 'bill_void', 'credit_note', 'credit_note_void',
    'supplier_credit_note', 'supplier_credit_note_void')),
  add column source_id bigint,
  add column reversal_of_movement_id bigint unique references inventory_movements(id),
  add constraint inventory_movements_zero_check check (quantity_after <> 0 or value_after = 0),
  add constraint inventory_movements_reversal_check check ((movement_type = 'reversal') = (reversal_of_movement_id is not null)),
  add constraint inventory_movements_source_check check ((source_type is null) = (source_id is null));
create index inventory_movements_balance_idx on inventory_movements (item_code, location_value_id, id);
create index inventory_movements_source_idx on inventory_movements (source_type, source_id);

-- Below zero only while the organisation allows negative stock (ST9, ST10).
create function tohyee_check_negative_stock() returns trigger
language plpgsql as $$
declare
  allowed boolean;
  below boolean;
begin
  if tg_table_name = 'inventory_movements' then
    below := new.quantity_after < 0 or new.value_after < 0;
  else
    below := new.on_hand_quantity < 0 or new.carrying_value < 0;
  end if;
  if below then
    select allow_negative_stock into allowed from organisation_settings where id = true;
    if not coalesce(allowed, false) then
      raise exception 'Stock can''t go negative' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger inventory_movements_negative before insert on inventory_movements
  for each row execute function tohyee_check_negative_stock();
create trigger inventory_item_balances_negative before insert or update on inventory_item_balances
  for each row execute function tohyee_check_negative_stock();

-- ST12: negative stock can't be turned off while anything is below zero.
create function tohyee_check_negative_stock_setting() returns trigger
language plpgsql as $$
begin
  if old.allow_negative_stock and not new.allow_negative_stock
     and exists (select 1 from inventory_item_balances where on_hand_quantity < 0 or carrying_value < 0) then
    raise exception 'Some stock is below zero, so negative stock can''t be turned off' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger organisation_settings_negative_stock before update of allow_negative_stock on organisation_settings
  for each row execute function tohyee_check_negative_stock_setting();

-- ST5: a credit note returning stock names the invoice it was sold on, so
-- it's restocked at that sale's cost.
alter table sales_credit_notes add column return_invoice_id bigint references sales_invoices(id);
`,
  };
