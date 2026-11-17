import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0079",
    name: "crm_opportunity_sales_order",
    sql: `
-- A won opportunity can make a sales order instead of an invoice (decision
-- 327; docs/ACCOUNTING-EXAMPLES.md CRM5b; NetSuite's opportunity to sales
-- order). One or the other, never both; once made, the stage is fixed.
alter table crm_opportunities add column sales_order_id bigint references sales_orders(id);
create unique index crm_opportunities_sales_order_idx on crm_opportunities (sales_order_id) where sales_order_id is not null;
alter table crm_opportunities add constraint crm_opportunities_one_document check (invoice_id is null or sales_order_id is null);

create or replace function tohyee_guard_crm_opportunity() returns trigger
language plpgsql as $$
begin
  if old.invoice_id is not null and (new.invoice_id is distinct from old.invoice_id or new.stage is distinct from old.stage) then
    raise exception 'This opportunity has made an invoice, so its stage can''t change' using errcode = 'P0001';
  end if;
  if old.sales_order_id is not null and (new.sales_order_id is distinct from old.sales_order_id or new.stage is distinct from old.stage) then
    raise exception 'This opportunity has made a sales order, so its stage can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function tohyee_crm_opportunity_sales_order_won() returns trigger
language plpgsql as $$
begin
  if new.sales_order_id is not null
     and (select stage_type from crm_opportunity_stages where key = new.stage) is distinct from 'won' then
    raise exception 'Only a won opportunity can have a sales order' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger crm_opportunities_sales_order_won before insert or update of stage, sales_order_id on crm_opportunities
  for each row execute function tohyee_crm_opportunity_sales_order_won();
`,
  };
