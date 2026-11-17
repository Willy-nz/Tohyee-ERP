import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0043",
    name: "multi_currency_settlements",
    sql: `
-- More multi-currency, following NetSuite (examples MC14-MC30): foreign
-- overpayments and refunds, payments for several foreign documents, and
-- quotes, repeating documents and purchase orders for foreign contacts.

-- A payment of a foreign-currency invoice can overpay it (MC14). The
-- overpayment is credit in the invoice's currency at the payment's rate:
-- base_overpayment is its base value (overpayment x rate, rounded once); the
-- invoice part clears the invoice at its carrying value (0 when it's all
-- overpayment), and the realised gain is on the invoice part only. Foreign
-- payments from before have no overpayment (null counts as 0). Parts of a
-- payment for several documents can be in a foreign currency now (MC20).
alter table customer_payments add column base_overpayment numeric;
alter table customer_payments drop constraint customer_payments_base_check;
alter table customer_payments add constraint customer_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and base_overpayment is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared >= 0 and coalesce(base_overpayment, 0) >= 0
      and realised_gain = base_amount - coalesce(base_overpayment, 0) - base_cleared
      and (overpayment_amount <> 0 or coalesce(base_overpayment, 0) = 0)
      and (amount <> overpayment_amount or base_cleared = 0)));
alter table supplier_payments drop constraint supplier_payments_base_check;
alter table supplier_payments add constraint supplier_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_cleared - base_amount));

-- Applying a foreign overpayment to another invoice (MC15) clears each side
-- at its own carrying value; a difference is a realised gain or loss in a
-- journal of its own, as for credit notes (MC7).
alter table customer_overpayment_applications
  add column invoice_base numeric, add column overpayment_base numeric, add column realised_gain numeric,
  add column journal_id bigint references ledger_journals(id);
alter table customer_overpayment_applications add constraint customer_overpayment_applications_base_check check (
  (invoice_base is null and overpayment_base is null and realised_gain is null and journal_id is null)
  or (invoice_base > 0 and overpayment_base > 0 and realised_gain = overpayment_base - invoice_base
      and (journal_id is null) = (realised_gain = 0)));

-- A refund of foreign-currency credit (an overpayment, a credit note or a
-- supplier credit note; MC16-MC18) is in the credit's currency at the
-- refund's own rate: base_amount is what moved in the bank account (amount x
-- rate, rounded once), base_cleared the credit's carrying value of what's
-- refunded, and the difference a realised gain (a loss is negative).
alter table customer_overpayment_refunds
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric, add column base_cleared numeric, add column realised_gain numeric;
alter table customer_overpayment_refunds add constraint customer_overpayment_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_cleared - base_amount));
alter table sales_credit_note_refunds
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric, add column base_cleared numeric, add column realised_gain numeric;
alter table sales_credit_note_refunds add constraint sales_credit_note_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_cleared - base_amount));
alter table supplier_credit_note_refunds
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric, add column base_cleared numeric, add column realised_gain numeric;
alter table supplier_credit_note_refunds add constraint supplier_credit_note_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_amount - base_cleared));

-- The base value settled on a foreign-currency document, or used of its
-- credit, by its active payments, applications and refunds.
create function tohyee_invoice_base_settled(invoice bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(base_cleared) from customer_payments where invoice_id = invoice and status = 'active'), 0)
       + coalesce((select sum(invoice_base) from sales_credit_note_applications where invoice_id = invoice and status = 'active'), 0)
       + coalesce((select sum(invoice_base) from customer_overpayment_applications where invoice_id = invoice and status = 'active'), 0)
$$;
create function tohyee_bill_base_settled(bill bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(base_cleared) from supplier_payments where bill_id = bill and status = 'active'), 0)
       + coalesce((select sum(bill_base) from supplier_credit_note_applications where bill_id = bill and status = 'active'), 0)
$$;
create function tohyee_credit_note_base_used(credit_note bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(credit_note_base) from sales_credit_note_applications where credit_note_id = credit_note and status = 'active'), 0)
       + coalesce((select sum(base_cleared) from sales_credit_note_refunds where credit_note_id = credit_note and status = 'active'), 0)
$$;
create function tohyee_supplier_credit_note_base_used(credit_note bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(credit_note_base) from supplier_credit_note_applications where credit_note_id = credit_note and status = 'active'), 0)
       + coalesce((select sum(base_cleared) from supplier_credit_note_refunds where credit_note_id = credit_note and status = 'active'), 0)
$$;
create function tohyee_overpayment_base_used(payment bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(overpayment_base) from customer_overpayment_applications where payment_id = payment and status = 'active'), 0)
       + coalesce((select sum(base_cleared) from customer_overpayment_refunds where payment_id = payment and status = 'active'), 0)
$$;

-- A payment for several foreign-currency documents (MC20-MC24) keeps its
-- rate and the base amount that moved in the bank account; its parts have
-- the same rate and their base amounts add up to it.
alter table customer_payment_batches
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric;
alter table customer_payment_batches add constraint customer_payment_batches_base_check
  check ((exchange_rate is null) = (base_amount is null) and (base_amount is null or base_amount > 0));
alter table supplier_payment_batches
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric;
alter table supplier_payment_batches add constraint supplier_payment_batches_base_check
  check ((exchange_rate is null) = (base_amount is null) and (base_amount is null or base_amount > 0));

create or replace function tohyee_check_payment_batch_parts() returns trigger
language plpgsql as $$
declare
  batch record;
  parts record;
begin
  if tg_table_name = 'customer_payment_batches' then
    select * into batch from customer_payment_batches where id = new.id;
    select count(*) as n, count(distinct p.invoice_id) as documents, coalesce(sum(p.amount), 0) as total,
           sum(p.base_amount) as base_total,
           bool_and(i.contact_id = batch.contact_id and p.payment_date = batch.payment_date
                    and p.bank_account_id = batch.bank_account_id and p.currency_code = batch.currency_code
                    and p.exchange_rate is not distinct from batch.exchange_rate
                    and p.journal_id = batch.journal_id and p.status = batch.status
                    and p.void_journal_id is not distinct from batch.void_journal_id) as agree
      into parts
      from customer_payments p join sales_invoices i on i.id = p.invoice_id
     where p.batch_id = new.id;
  else
    select * into batch from supplier_payment_batches where id = new.id;
    select count(*) as n, count(distinct p.bill_id) as documents, coalesce(sum(p.amount), 0) as total,
           sum(p.base_amount) as base_total,
           bool_and(b.contact_id = batch.contact_id and p.payment_date = batch.payment_date
                    and p.bank_account_id = batch.bank_account_id and p.currency_code = batch.currency_code
                    and p.exchange_rate is not distinct from batch.exchange_rate
                    and p.journal_id = batch.journal_id and p.status = batch.status
                    and p.void_journal_id is not distinct from batch.void_journal_id) as agree
      into parts
      from supplier_payments p join bills b on b.id = p.bill_id
     where p.batch_id = new.id;
  end if;
  if parts.n = 0 or parts.documents <> parts.n or parts.total <> batch.amount or not parts.agree
     or parts.base_total is distinct from batch.base_amount then
    raise exception 'A payment for several documents must be made of one part for each, adding up to the amount paid'
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;

-- Quotes, repeating invoices and bills, and purchase orders are in their
-- contact's currency too (MC25-MC28; NetSuite keeps "the currency from the
-- original transaction"). They post nothing, so they have no rate. A
-- contact's currency can't change once it has any of them either.
create function tohyee_check_contact_currency() returns trigger
language plpgsql as $$
declare
  wanted text;
begin
  select coalesce(c.currency_code, s.base_currency) into wanted
    from contacts c cross join organisation_settings s where c.id = new.contact_id;
  if wanted is not null and new.currency_code <> wanted then
    raise exception 'This contact''s documents are in %, not %', wanted, new.currency_code using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger quotes_currency_check before insert or update of contact_id, currency_code on quotes
  for each row execute function tohyee_check_contact_currency();
create trigger repeating_invoices_currency_check before insert or update of contact_id, currency_code on repeating_invoices
  for each row execute function tohyee_check_contact_currency();
create trigger repeating_bills_currency_check before insert or update of contact_id, currency_code on repeating_bills
  for each row execute function tohyee_check_contact_currency();
create trigger purchase_orders_currency_check before insert or update of contact_id, currency_code on purchase_orders
  for each row execute function tohyee_check_contact_currency();

create or replace function tohyee_guard_contact_currency() returns trigger
language plpgsql as $$
begin
  if coalesce(new.currency_code, '') is distinct from coalesce(old.currency_code, '')
     and (exists (select 1 from sales_invoices where contact_id = old.id)
          or exists (select 1 from bills where contact_id = old.id)
          or exists (select 1 from sales_credit_notes where contact_id = old.id)
          or exists (select 1 from supplier_credit_notes where contact_id = old.id)
          or exists (select 1 from quotes where contact_id = old.id)
          or exists (select 1 from repeating_invoices where contact_id = old.id)
          or exists (select 1 from repeating_bills where contact_id = old.id)
          or exists (select 1 from purchase_orders where contact_id = old.id)) then
    raise exception 'Contact % has documents, so its currency can''t change', old.name
      using errcode = '23514';
  end if;
  return new;
end;
$$;
`,
  };
