import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0302",
    name: "spreading_bank_and_accrual_links",
    sql: `
-- "Spread this" on a bank transaction line (SW19), and a bill, invoice or
-- bank line that is the one an accrual was waiting for (SW20, SW21).
alter table spread_items
  -- No foreign key, as with the bill and invoice line ids (0301).
  add column bank_line_id bigint,
  -- The months dropped when an accrual was marked as billed or invoiced, so undoing that can bring them back (SW21).
  add column settled_dropped jsonb,
  drop constraint spread_items_one_source,
  drop constraint spread_items_bill_kind,
  drop constraint spread_items_invoice_kind,
  add constraint spread_items_one_source check (num_nonnulls(bill_line_id, invoice_line_id, bank_line_id) <= 1),
  add constraint spread_items_bill_kind check (bill_line_id is null or kind in ('prepayment', 'accrued_expense')),
  add constraint spread_items_invoice_kind check (invoice_line_id is null or kind in ('income_in_advance', 'accrued_income'));

-- Stand-alone (SW23): the books are kept in other software, so the worksheet
-- isn't checked against this ledger and each month's journal is taken away as a file.
alter table spreading_settings add column books_elsewhere boolean not null default false;

create unique index spread_items_bank_line on spread_items (bank_line_id) where bank_line_id is not null and removed_at is null;

-- A bank transaction can't be voided while one of its lines is on the worksheet.
create function tohyee_check_bank_transaction_spreading() returns trigger
language plpgsql as $$
declare
  item text;
begin
  if new.status = 'voided' and old.status <> 'voided' then
    select i.description into item from spread_items i join bank_transaction_lines l on l.id = i.bank_line_id
     where l.bank_transaction_id = new.id and i.removed_at is null order by i.id limit 1;
    if item is not null then
      raise exception '"%" from this bank transaction is on the Spreading worksheet, so it can''t be voided or recoded. Take it off the worksheet first', item
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger bank_transactions_spreading before update on bank_transactions
  for each row execute function tohyee_check_bank_transaction_spreading();
`,
  };
