import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0077",
    name: "expense_claim_receipt_gst_number",
    sql: `
-- The supplier's GST number on an expense claim receipt (decision 293;
-- docs/ACCOUNTING-EXAMPLES.md EC13): IRD's taxable supply information over
-- $200 shows it, so it's needed to claim GST on such a receipt.
alter table expense_claim_receipts
  add column supplier_gst_number text check (supplier_gst_number is null or supplier_gst_number ~ '^[0-9]{8,9}$');
`,
  };
