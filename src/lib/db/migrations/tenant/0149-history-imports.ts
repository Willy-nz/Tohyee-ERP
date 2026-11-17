import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0149",
    name: "history_imports",
    sql: `
-- A general ledger from another system brought in as history (examples
-- IM22-IM28): one journal per transaction (date and ID#), origin 'history',
-- left out of the journal list unless asked for.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal',
                    'opening_balance', 'payroll', 'livestock_valuation', 'livestock_rations', 'recode', 'history'));

create table history_imports (
  id bigserial primary key,
  idempotency_key text not null unique,
  request_hash text not null,
  file_name text not null check (length(file_name) between 1 and 255),
  from_date date not null,
  to_date date not null check (to_date >= from_date),
  journal_count integer not null check (journal_count > 0),
  line_count integer not null check (line_count >= journal_count * 2),
  total_debit numeric(18, 2) not null,
  skipped_rows integer not null default 0,
  created_by_email text,
  created_at timestamptz not null default now()
);

-- Each journal an import posted, by its date and reference, so the same
-- transaction can't come in twice from overlapping files (IM26).
create table history_import_journals (
  journal_id bigint primary key references ledger_journals(id),
  history_import_id bigint not null references history_imports(id),
  posting_date date not null,
  reference_key text not null,
  unique (posting_date, reference_key)
);
create index history_import_journals_import_idx on history_import_journals (history_import_id);

alter table import_mappings drop constraint import_mappings_kind_check;
alter table import_mappings add constraint import_mappings_kind_check
  check (kind in ('accounts', 'contacts', 'items', 'trial_balance', 'stock', 'open_invoices', 'open_bills', 'general_ledger'));
`,
  };
