import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0123",
    name: "sales_line_discounts",
    sql: `
-- Line discounts on sales documents (examples DS1-DS6, approved by Jess
-- 10 Oct 2026): a percent off each line, 0 to 100. The line amount is
-- quantity x unit price less the discount, rounded once; only a discounted
-- line can come to 0.00 (100% off). Bills and purchase orders don't get one.
alter table sales_invoice_lines add column discount_percent numeric(5, 2) not null default 0 check (discount_percent >= 0 and discount_percent <= 100);
alter table sales_invoice_lines drop constraint sales_invoice_lines_line_amount_check;
alter table sales_invoice_lines add constraint sales_invoice_lines_line_amount_check check (line_amount > 0 or (line_amount = 0 and discount_percent > 0));
alter table sales_credit_note_lines add column discount_percent numeric(5, 2) not null default 0 check (discount_percent >= 0 and discount_percent <= 100);
alter table sales_credit_note_lines drop constraint sales_credit_note_lines_line_amount_check;
alter table sales_credit_note_lines add constraint sales_credit_note_lines_line_amount_check check (line_amount > 0 or (line_amount = 0 and discount_percent > 0));
alter table quote_lines add column discount_percent numeric(5, 2) not null default 0 check (discount_percent >= 0 and discount_percent <= 100);
alter table quote_lines drop constraint quote_lines_line_amount_check;
alter table quote_lines add constraint quote_lines_line_amount_check check (line_amount > 0 or (line_amount = 0 and discount_percent > 0));
alter table repeating_invoice_lines add column discount_percent numeric(5, 2) not null default 0 check (discount_percent >= 0 and discount_percent <= 100);
alter table repeating_invoice_lines drop constraint repeating_invoice_lines_line_amount_check;
alter table repeating_invoice_lines add constraint repeating_invoice_lines_line_amount_check check (line_amount > 0 or (line_amount = 0 and discount_percent > 0));
alter table sales_order_lines add column discount_percent numeric(5, 2) not null default 0 check (discount_percent >= 0 and discount_percent <= 100);
alter table sales_order_lines drop constraint sales_order_lines_line_amount_check;
alter table sales_order_lines add constraint sales_order_lines_line_amount_check check (line_amount > 0 or (line_amount = 0 and discount_percent > 0));
`,
  };
