import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0301",
    name: "spread_this",
    sql: `
-- "Spread this" on an approved bill or invoice line (examples SW15-SW17):
-- the item remembers the line it came from and the journal that moved the
-- line's amount into the kind's balance sheet account.
alter table spread_items
  -- No foreign key on the two line ids: one would stop the lines tables' own
  -- guards refusing TRUNCATE with their message. Approved lines are never deleted.
  add column bill_line_id bigint,
  add column invoice_line_id bigint,
  add column move_journal_id bigint references ledger_journals(id),
  add column move_undo_journal_id bigint references ledger_journals(id),
  -- The line's tracking, carried to each month's journal.
  add column tracking jsonb not null default '{}'::jsonb,
  add constraint spread_items_one_source check (bill_line_id is null or invoice_line_id is null),
  add constraint spread_items_bill_kind check (bill_line_id is null or kind = 'prepayment'),
  add constraint spread_items_invoice_kind check (invoice_line_id is null or kind = 'income_in_advance');

-- A line is spread once.
create unique index spread_items_bill_line on spread_items (bill_line_id) where bill_line_id is not null and removed_at is null;
create unique index spread_items_invoice_line on spread_items (invoice_line_id) where invoice_line_id is not null and removed_at is null;

-- A bill or invoice can't be voided while one of its lines is on the
-- worksheet (SW17): the worksheet would hold an amount the ledger no longer has.
create function tohyee_check_bill_spreading() returns trigger
language plpgsql as $$
declare
  item text;
begin
  if new.status = 'voided' and old.status <> 'voided' then
    select i.description into item from spread_items i join bill_lines l on l.id = i.bill_line_id
     where l.bill_id = new.id and i.removed_at is null order by i.id limit 1;
    if item is not null then
      raise exception '"%" from this bill is on the Spreading worksheet, so the bill can''t be voided. Remove it from the worksheet first', item
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger bills_spreading before update on bills
  for each row execute function tohyee_check_bill_spreading();

create function tohyee_check_invoice_spreading() returns trigger
language plpgsql as $$
declare
  item text;
begin
  if new.status = 'voided' and old.status <> 'voided' then
    select i.description into item from spread_items i join sales_invoice_lines l on l.id = i.invoice_line_id
     where l.invoice_id = new.id and i.removed_at is null order by i.id limit 1;
    if item is not null then
      raise exception '"%" from this invoice is on the Spreading worksheet, so the invoice can''t be voided. Remove it from the worksheet first', item
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger sales_invoices_spreading before update on sales_invoices
  for each row execute function tohyee_check_invoice_spreading();
`,
  };
