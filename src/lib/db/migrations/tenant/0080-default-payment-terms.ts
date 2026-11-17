import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0080",
    name: "default_payment_terms",
    sql: `
-- The organisation's own payment terms for new invoices and for new bills,
-- used when the customer or supplier has none (decision 333; Xero's
-- default due dates in invoice settings).
alter table organisation_settings
  add column default_sales_payment_term_id bigint references payment_terms(id),
  add column default_bill_payment_term_id bigint references payment_terms(id);
`,
  };
