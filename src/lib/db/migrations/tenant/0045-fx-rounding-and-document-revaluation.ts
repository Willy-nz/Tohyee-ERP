import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0045",
    name: "fx_rounding_and_document_revaluation",
    sql: `
-- Following NetSuite (examples MC31-MC45): the cent or two left by rounding
-- when a payment or credit settles a foreign-currency document goes to a
-- Rounding Gain/Loss account of its own, apart from the realised gain or
-- loss ((payment rate - document rate) x amount, rounded to cents); and open
-- invoices, bills, credit notes and overpayments are revalued one by one.

-- The rounding account: 7050 in the starting chart; existing organisations
-- get it here, at 7050 or the next free code after it.
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(7050, 7999) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Rounding gains and losses', 'revenue', 'other_income', 'fx_rounding'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'fx_rounding')
   and exists (select 1 from generate_series(7050, 7999) c where not exists (select 1 from accounts where lower(code) = c::text));

-- Each settlement keeps its realised gain (on 7020) and its rounding (on
-- 7050) apart; together they're the difference, as before. Settlements from
-- before have no rounding (null): all of it went to 7020.
alter table customer_payments add column rounding_gain numeric;
alter table customer_payments drop constraint customer_payments_base_check;
alter table customer_payments add constraint customer_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and base_overpayment is null
   and rounding_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared >= 0 and coalesce(base_overpayment, 0) >= 0
      and realised_gain + coalesce(rounding_gain, 0) = base_amount - coalesce(base_overpayment, 0) - base_cleared
      and (overpayment_amount <> 0 or coalesce(base_overpayment, 0) = 0)
      and (amount <> overpayment_amount or base_cleared = 0)));
alter table supplier_payments add column rounding_gain numeric;
alter table supplier_payments drop constraint supplier_payments_base_check;
alter table supplier_payments add constraint supplier_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and rounding_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0
      and realised_gain + coalesce(rounding_gain, 0) = base_cleared - base_amount));
alter table sales_credit_note_applications add column rounding_gain numeric;
alter table sales_credit_note_applications drop constraint sales_credit_note_applications_base_check;
alter table sales_credit_note_applications add constraint sales_credit_note_applications_base_check check (
  (invoice_base is null and credit_note_base is null and realised_gain is null and journal_id is null and rounding_gain is null)
  or (invoice_base > 0 and credit_note_base > 0 and realised_gain + coalesce(rounding_gain, 0) = credit_note_base - invoice_base
      and (journal_id is null) = (realised_gain = 0 and coalesce(rounding_gain, 0) = 0)));
alter table supplier_credit_note_applications add column rounding_gain numeric;
alter table supplier_credit_note_applications drop constraint supplier_credit_note_applications_base_check;
alter table supplier_credit_note_applications add constraint supplier_credit_note_applications_base_check check (
  (bill_base is null and credit_note_base is null and realised_gain is null and journal_id is null and rounding_gain is null)
  or (bill_base > 0 and credit_note_base > 0 and realised_gain + coalesce(rounding_gain, 0) = bill_base - credit_note_base
      and (journal_id is null) = (realised_gain = 0 and coalesce(rounding_gain, 0) = 0)));
alter table customer_overpayment_applications add column rounding_gain numeric;
alter table customer_overpayment_applications drop constraint customer_overpayment_applications_base_check;
alter table customer_overpayment_applications add constraint customer_overpayment_applications_base_check check (
  (invoice_base is null and overpayment_base is null and realised_gain is null and journal_id is null and rounding_gain is null)
  or (invoice_base > 0 and overpayment_base > 0 and realised_gain + coalesce(rounding_gain, 0) = overpayment_base - invoice_base
      and (journal_id is null) = (realised_gain = 0 and coalesce(rounding_gain, 0) = 0)));
alter table customer_overpayment_refunds add column rounding_gain numeric;
alter table customer_overpayment_refunds drop constraint customer_overpayment_refunds_base_check;
alter table customer_overpayment_refunds add constraint customer_overpayment_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and rounding_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0
      and realised_gain + coalesce(rounding_gain, 0) = base_cleared - base_amount));
alter table sales_credit_note_refunds add column rounding_gain numeric;
alter table sales_credit_note_refunds drop constraint sales_credit_note_refunds_base_check;
alter table sales_credit_note_refunds add constraint sales_credit_note_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and rounding_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0
      and realised_gain + coalesce(rounding_gain, 0) = base_cleared - base_amount));
alter table supplier_credit_note_refunds add column rounding_gain numeric;
alter table supplier_credit_note_refunds drop constraint supplier_credit_note_refunds_base_check;
alter table supplier_credit_note_refunds add constraint supplier_credit_note_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and rounding_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0
      and realised_gain + coalesce(rounding_gain, 0) = base_amount - base_cleared));

-- A revaluation of accounts receivable or payable in one currency lists each
-- open document it revalued (NetSuite's Open Receivables and Open
-- Payables): its open foreign amount and base value in the account's normal
-- direction (credit notes and overpayments are negative), its own rate, and
-- its unrealised amount = (closing rate - its rate) x open foreign amount,
-- rounded once. The account and currency's item is their total.
create table ledger_fx_revaluation_documents (
  id bigserial primary key,
  run_id bigint not null references ledger_fx_revaluation_runs(id),
  item_line_order integer not null,
  line_order integer not null,
  document_kind text not null
    check (document_kind in ('invoice', 'credit_note', 'overpayment', 'bill', 'supplier_credit_note')),
  document_id bigint not null,
  document_number text,
  document_date date not null,
  currency_code text not null,
  foreign_amount numeric not null check (foreign_amount <> 0),
  carrying_amount numeric not null,
  document_rate numeric not null check (document_rate > 0),
  closing_rate numeric not null check (closing_rate > 0),
  delta_amount numeric not null,
  unique (run_id, line_order),
  unique (run_id, document_kind, document_id),
  foreign key (run_id, item_line_order) references ledger_fx_revaluation_run_items (run_id, line_order),
  check (delta_amount = round((closing_rate - document_rate) * foreign_amount, scale(delta_amount)))
);
create trigger ledger_fx_revaluation_documents_append_only
  before update or delete on ledger_fx_revaluation_documents
  for each row execute function toeyee_forbid_mutation();
create trigger ledger_fx_revaluation_documents_no_truncate
  before truncate on ledger_fx_revaluation_documents
  for each statement execute function toeyee_forbid_mutation();
`,
  };
