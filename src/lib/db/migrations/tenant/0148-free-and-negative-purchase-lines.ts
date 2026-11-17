import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0148",
    name: "free_and_negative_purchase_lines",
    sql: `
-- Free and negative lines on bills, purchase orders and repeating bills, as
-- in Xero (examples ZN5-ZN8); the total stays above zero (checked when
-- saved). A document's GST can be below zero when a negative line carries
-- GST and the rest doesn't (ZN8), on sales documents too.
alter table bill_lines drop constraint bill_lines_unit_price_check;
alter table bill_lines add constraint bill_lines_unit_price_check check (scale(unit_price) <= 4);
alter table bill_lines drop constraint bill_lines_net_amount_check;
alter table bill_lines drop constraint bill_lines_tax_amount_check;
alter table bill_lines drop constraint bill_lines_line_amount_check;
alter table bill_lines add constraint bill_lines_line_amount_check check (line_amount <> 0 or unit_price = 0);
alter table purchase_order_lines drop constraint purchase_order_lines_unit_price_check;
alter table purchase_order_lines add constraint purchase_order_lines_unit_price_check check (scale(unit_price) <= 4);
alter table purchase_order_lines drop constraint purchase_order_lines_net_amount_check;
alter table purchase_order_lines drop constraint purchase_order_lines_tax_amount_check;
alter table purchase_order_lines drop constraint purchase_order_lines_line_amount_check;
alter table purchase_order_lines add constraint purchase_order_lines_line_amount_check check (line_amount <> 0 or unit_price = 0);
alter table repeating_bill_lines drop constraint repeating_bill_lines_unit_price_check;
alter table repeating_bill_lines add constraint repeating_bill_lines_unit_price_check check (scale(unit_price) <= 4);
alter table repeating_bill_lines drop constraint repeating_bill_lines_net_amount_check;
alter table repeating_bill_lines drop constraint repeating_bill_lines_tax_amount_check;
alter table repeating_bill_lines drop constraint repeating_bill_lines_line_amount_check;
alter table repeating_bill_lines add constraint repeating_bill_lines_line_amount_check check (line_amount <> 0 or unit_price = 0);
alter table bills drop constraint bills_tax_total_check;
alter table purchase_orders drop constraint purchase_orders_tax_total_check;
alter table repeating_bills drop constraint repeating_bills_tax_total_check;
alter table sales_invoices drop constraint sales_invoices_tax_total_check;
alter table quotes drop constraint quotes_tax_total_check;
alter table repeating_invoices drop constraint repeating_invoices_tax_total_check;
alter table sales_orders drop constraint sales_orders_tax_total_check;
`,
  };
