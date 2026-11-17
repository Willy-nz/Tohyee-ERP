import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0012",
    name: "gst_payments_and_hybrid_bases",
    sql: `
-- On the payments and hybrid bases a document counts when it's settled: paid,
-- credited or refunded (examples G10-G19). Each settlement counts the
-- document's lines in proportion, and the filed line keeps the amount settled
-- and the document's total it was worked out from.
alter table gst_return_lines drop constraint gst_return_lines_event_type_check;
alter table gst_return_lines add constraint gst_return_lines_event_type_check
  check (event_type in ('invoice_approved', 'invoice_voided', 'credit_note_approved', 'credit_note_voided',
                        'bill_approved', 'bill_voided', 'supplier_credit_note_approved', 'supplier_credit_note_voided',
                        'bank_transaction_posted', 'bank_transaction_voided',
                        'customer_payment', 'customer_payment_voided',
                        'credit_note_applied', 'credit_note_application_removed',
                        'credit_note_refunded', 'credit_note_refund_voided',
                        'overpayment_applied', 'overpayment_application_removed',
                        'supplier_payment', 'supplier_payment_voided',
                        'supplier_credit_note_applied', 'supplier_credit_note_application_removed',
                        'supplier_credit_note_refunded', 'supplier_credit_note_refund_voided'));
alter table gst_return_lines
  add column settled_amount numeric check (settled_amount > 0),
  add column document_total numeric check (document_total > 0),
  add constraint gst_return_lines_settlement_check check ((settled_amount is null) = (document_total is null));
`,
  };
