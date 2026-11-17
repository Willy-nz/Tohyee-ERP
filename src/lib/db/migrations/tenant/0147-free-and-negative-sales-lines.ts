import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0147",
    name: "free_and_negative_sales_lines",
    sql: `
-- Free ($0) and negative (discount or credit) lines on sales documents, as
-- in Xero (examples ZN1-ZN4). The document's total stays above zero (checked
-- when it's saved). A line comes to 0.00 only when it's free or 100% off.
alter table sales_invoice_lines drop constraint sales_invoice_lines_unit_price_check;
alter table sales_invoice_lines add constraint sales_invoice_lines_unit_price_check check (true);
alter table sales_invoice_lines drop constraint sales_invoice_lines_net_amount_check;
alter table sales_invoice_lines drop constraint sales_invoice_lines_tax_amount_check;
alter table sales_invoice_lines drop constraint sales_invoice_lines_line_amount_check;
alter table sales_invoice_lines add constraint sales_invoice_lines_line_amount_check check (line_amount <> 0 or unit_price = 0 or discount_percent > 0);
alter table quote_lines drop constraint quote_lines_unit_price_check;
alter table quote_lines add constraint quote_lines_unit_price_check check (true);
alter table quote_lines drop constraint quote_lines_net_amount_check;
alter table quote_lines drop constraint quote_lines_tax_amount_check;
alter table quote_lines drop constraint quote_lines_line_amount_check;
alter table quote_lines add constraint quote_lines_line_amount_check check (line_amount <> 0 or unit_price = 0 or discount_percent > 0);
alter table repeating_invoice_lines drop constraint repeating_invoice_lines_unit_price_check;
alter table repeating_invoice_lines add constraint repeating_invoice_lines_unit_price_check check (true);
alter table repeating_invoice_lines drop constraint repeating_invoice_lines_net_amount_check;
alter table repeating_invoice_lines drop constraint repeating_invoice_lines_tax_amount_check;
alter table repeating_invoice_lines drop constraint repeating_invoice_lines_line_amount_check;
alter table repeating_invoice_lines add constraint repeating_invoice_lines_line_amount_check check (line_amount <> 0 or unit_price = 0 or discount_percent > 0);
alter table sales_order_lines drop constraint sales_order_lines_unit_price_check;
alter table sales_order_lines add constraint sales_order_lines_unit_price_check check (true and scale(unit_price) <= 4);
alter table sales_order_lines drop constraint sales_order_lines_net_amount_check;
alter table sales_order_lines drop constraint sales_order_lines_tax_amount_check;
alter table sales_order_lines drop constraint sales_order_lines_line_amount_check;
alter table sales_order_lines add constraint sales_order_lines_line_amount_check check (line_amount <> 0 or unit_price = 0 or discount_percent > 0);
`,
  };
