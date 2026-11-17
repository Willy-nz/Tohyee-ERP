import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0124",
    name: "crm_deal_products",
    sql: `
-- Deal products and quotes (decision 502, examples DS7-DS9 approved by Jess
-- 10 Oct 2026). A deal's lines are excluding GST; with lines, its amount is
-- their total. A quote made from a deal remembers it; accepting the quote
-- wins the deal and links the invoice or sales order.
create table crm_opportunity_lines (
  id bigserial primary key,
  opportunity_id bigint not null references crm_opportunities(id),
  line_order integer not null check (line_order > 0),
  item_id bigint references items(id),
  description text not null check (length(description) between 1 and 500),
  quantity numeric not null check (quantity > 0 and scale(quantity) <= 4),
  unit_price numeric not null check (unit_price > 0 and scale(unit_price) <= 4),
  discount_percent numeric(5, 2) not null default 0 check (discount_percent >= 0 and discount_percent <= 100),
  line_amount numeric not null check (line_amount >= 0),
  unique (opportunity_id, line_order)
);

alter table quotes add column opportunity_id bigint references crm_opportunities(id);
create index quotes_opportunity on quotes (opportunity_id) where opportunity_id is not null;
`,
  };
