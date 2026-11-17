import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0076",
    name: "purchase_order_close",
    sql: `
-- Closing the rest of a purchase order (decision 281; docs/ACCOUNTING-EXAMPLES.md
-- PO10; Xero's "mark as billed", NetSuite's close): an approved one with no
-- draft bills becomes closed, so what's left isn't on order any more. Its
-- approved bills stay (and can still be voided); no new bills come from it.
alter table purchase_orders drop constraint purchase_orders_status_check;
alter table purchase_orders add constraint purchase_orders_status_check check (status in ('draft', 'approved', 'cancelled', 'closed'));
alter table purchase_orders
  add column close_command_source text,
  add column close_idempotency_key text,
  add column close_request_hash text,
  add column closed_by_user_id uuid,
  add column closed_by_email text,
  add column closed_at timestamptz,
  add constraint purchase_orders_close_key unique (close_command_source, close_idempotency_key),
  add constraint purchase_orders_closed_at check ((status = 'closed') = (closed_at is not null));

create or replace function tohyee_guard_purchase_order() returns trigger
language plpgsql as $$
declare
  cancel_columns text[] := array['status', 'cancel_command_source', 'cancel_idempotency_key', 'cancel_request_hash',
    'cancelled_by_user_id', 'cancelled_by_email', 'cancelled_at', 'updated_at'];
  close_columns text[] := array['status', 'close_command_source', 'close_idempotency_key', 'close_request_hash',
    'closed_by_user_id', 'closed_by_email', 'closed_at', 'updated_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'purchase_orders can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.status in ('cancelled', 'closed') then
      raise exception 'A draft purchase order can''t be cancelled or closed; delete it instead' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Purchase order % is %, so it can''t be deleted', old.po_number, old.status using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'cancelled'
     and (to_jsonb(new) - cancel_columns) = (to_jsonb(old) - cancel_columns) then
    if exists (select 1 from bills where purchase_order_id = old.id and status <> 'voided') then
      raise exception 'Purchase order % has bills, so it can''t be cancelled', old.po_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status = 'approved' and new.status = 'closed'
     and (to_jsonb(new) - close_columns) = (to_jsonb(old) - close_columns) then
    if exists (select 1 from bills where purchase_order_id = old.id and status = 'draft') then
      raise exception 'Purchase order % has a draft bill, so it can''t be closed', old.po_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Purchase order % is %, so it can''t be changed', old.po_number, old.status using errcode = 'P0001';
end;
$$;

-- New bills only from an approved purchase order; a bill already from one
-- that's since been closed can still change (be voided, say).
create or replace function tohyee_check_bill_purchase_order() returns trigger
language plpgsql as $$
declare
  po record;
begin
  if tg_op = 'UPDATE' and new.purchase_order_id is distinct from old.purchase_order_id then
    raise exception 'A bill''s purchase order can''t be changed' using errcode = 'P0001';
  end if;
  if new.purchase_order_id is null then
    return new;
  end if;
  select status, contact_id into po from purchase_orders where id = new.purchase_order_id;
  if po.status <> 'approved' and not (tg_op = 'UPDATE' and po.status = 'closed') then
    raise exception 'Bills can only be made from an approved purchase order' using errcode = 'P0001';
  end if;
  if po.contact_id <> new.contact_id then
    raise exception 'A bill from a purchase order must be from the purchase order''s supplier' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
`,
  };
