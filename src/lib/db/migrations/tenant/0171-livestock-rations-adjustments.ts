import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0171",
    name: "livestock_rations_adjustments",
    sql: `
-- The owner's rations (homekill) as one adjustment a year (examples RAT1,
-- RAT3-RAT10, decisions 624-627; Jess, 20 October 2026). The accountant
-- enters the amount, its basis, and whether GST applies (GST-registered
-- farms only, and whether the amount includes it). It posts Dr owner
-- drawings or current account, Cr rations income (and Cr GST), on the
-- balance date or a date in the year; with GST it counts in that date's GST
-- return. Homekill movements stay head counts and post nothing. A new
-- amount for a year means voiding the old one (with a reason, reversed on
-- its date) and entering another.
create table livestock_rations_adjustments (
  id bigserial primary key,
  idempotency_key text not null unique,
  request_hash text not null,
  year_end date not null,
  adjustment_date date not null check (adjustment_date <= year_end),
  amount numeric(18, 2) not null check (amount > 0),
  reason text not null check (length(reason) between 1 and 500),
  gst_applies boolean not null,
  amount_includes_gst boolean,
  check (gst_applies = (amount_includes_gst is not null)),
  net_amount numeric(18, 2) not null check (net_amount > 0),
  gst_amount numeric(18, 2) not null default 0 check (gst_amount >= 0),
  check (gst_applies or gst_amount = 0),
  tax_code_id bigint references tax_codes(id),
  check (gst_applies = (tax_code_id is not null)),
  journal_id bigint not null references ledger_journals(id),
  created_by_email text,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by_email text,
  void_reason text check (void_reason is null or length(void_reason) between 1 and 500),
  void_journal_id bigint references ledger_journals(id),
  check ((voided_at is null) = (void_reason is null))
);
create unique index livestock_rations_adjustments_one_a_year on livestock_rations_adjustments (year_end) where voided_at is null;

-- With GST, the adjustment is a GST return line on the sales side, with no contact.
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
                        'supplier_credit_note_refunded', 'supplier_credit_note_refund_voided',
                        'expense_claim_approved', 'expense_claim_voided',
                        'expense_claim_payment', 'expense_claim_payment_voided',
                        'rations_adjustment'));
alter table gst_return_lines drop constraint gst_return_lines_document_type_check;
alter table gst_return_lines add constraint gst_return_lines_document_type_check
  check (document_type in ('sales_invoice', 'sales_credit_note', 'bill', 'supplier_credit_note', 'bank_transaction',
                           'expense_claim', 'livestock_rations'));
`,
  };
