import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0139",
    name: "livestock_rations",
    sql: `
-- Stock killed for rations (#259, examples RAT1-RAT4): its own movement and
-- tally line. The owner's rations are income at market value (IR3F: private
-- use at market value), posted Dr drawings, Cr rations income. Staff rations
-- post nothing; the lower closing stock is the cost.
alter table livestock_movements drop constraint livestock_movements_movement_type_check;
alter table livestock_movements add constraint livestock_movements_movement_type_check check (movement_type in (
  'birth', 'purchase', 'sale', 'death', 'missing', 'found', 'reclass', 'transfer', 'arrival', 'departure', 'rations'));
alter table livestock_movements add column rations_for text check (rations_for is null or rations_for in ('owner', 'staff'));
alter table livestock_movements add column journal_id bigint references ledger_journals(id);
alter table livestock_movements add column void_journal_id bigint references ledger_journals(id);
alter table livestock_movements add constraint livestock_movements_rations_for check ((movement_type = 'rations') = (rations_for is not null));
alter table livestock_movements drop constraint livestock_movements_check4;
alter table livestock_movements add constraint livestock_movements_check4 check (
  movement_type in ('purchase', 'sale')
  or (movement_type = 'rations' and rations_for = 'owner' and amount is not null and amount > 0 and sales_invoice_line_id is null and bill_line_id is null)
  or (amount is null and sales_invoice_line_id is null and bill_line_id is null));
alter table livestock_movements add constraint livestock_movements_rations_journal check (journal_id is null or rations_for = 'owner');

alter table livestock_settings add column rations_income_account_id bigint references accounts(id);
alter table livestock_settings add column drawings_account_id bigint references accounts(id);

alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal',
                    'opening_balance', 'payroll', 'livestock_valuation', 'livestock_rations'));
`,
  };
