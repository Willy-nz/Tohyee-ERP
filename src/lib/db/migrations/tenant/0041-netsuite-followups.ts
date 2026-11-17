import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0041",
    name: "netsuite_followups",
    sql: `
-- Following NetSuite (decided 1 Oct 2026, examples SPT1-SPT5, RB11-RB13,
-- GP1-GP6):
--
-- Supplier payment terms (NetSuite vendors have a Terms field): a supplier's
-- default term, from the same list as customers' terms. It's its own column
-- because a contact that's both a customer and a supplier can have different
-- terms each way.
alter table contacts
  add column supplier_payment_term_id bigint references payment_terms(id);

-- A draft bill can be saved without the supplier's invoice number (NetSuite's
-- reference number is optional), to be filled in when the real invoice
-- arrives. Approving still needs one, unique for the supplier (B5): approved
-- and voided bills always have it.
alter table bills alter column supplier_invoice_number drop not null;
alter table bills add constraint bills_number_unless_draft
  check (status = 'draft' or supplier_invoice_number is not null);

-- A repeating bill can leave the number pattern empty; its bills are then
-- always drafts without a number (RB11). Its due date can come from the
-- supplier's payment terms (RB12).
alter table repeating_bills alter column supplier_invoice_number drop not null;
alter table repeating_bills add constraint repeating_bills_number_or_draft
  check (supplier_invoice_number is not null or save_as = 'draft');
alter table repeating_bills drop constraint repeating_bills_due_rule_check;
alter table repeating_bills add constraint repeating_bills_due_rule_check
  check (due_rule in ('days_after', 'days_after_month_end', 'day_of_next_month', 'terms'));
alter table repeating_bills add constraint repeating_bills_terms_days
  check (due_rule <> 'terms' or due_days = 0);

-- The GST filing frequency (NetSuite's tax periods): 1, 2 or 6 months, and
-- which months the periods end in, kept as the first month of the year a
-- period ends in (1 for monthly; 1 or 2 for two-monthly, odd or even
-- months; 1-6 for six-monthly, e.g. 3 for March and September). Null until
-- it's set; the GST return and the period close then fall back to the
-- latest filed return's length.
alter table organisation_settings
  add column gst_period_months smallint check (gst_period_months in (1, 2, 6)),
  add column gst_period_end_month smallint,
  add constraint organisation_settings_gst_period
    check ((gst_period_months is null and gst_period_end_month is null)
        or (gst_period_months is not null and gst_period_end_month between 1 and gst_period_months));
`,
  };
