import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0042",
    name: "multi_currency_documents",
    sql: `
-- Multi-currency sales invoices, bills, credit notes and payments (examples
-- MC1-MC13, following NetSuite). A contact has a currency (null: the base
-- currency), like a NetSuite customer's or vendor's primary currency, and its
-- invoices, bills and credit notes are in it. It can't change once the
-- contact has any.
alter table contacts add column currency_code text check (currency_code ~ '^[A-Z]{3}$');

create function tohyee_guard_contact_currency() returns trigger
language plpgsql as $$
begin
  if coalesce(new.currency_code, '') is distinct from coalesce(old.currency_code, '')
     and (exists (select 1 from sales_invoices where contact_id = old.id)
          or exists (select 1 from bills where contact_id = old.id)
          or exists (select 1 from sales_credit_notes where contact_id = old.id)
          or exists (select 1 from supplier_credit_notes where contact_id = old.id)) then
    raise exception 'Contact % has invoices, bills or credit notes, so its currency can''t change', old.name
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger contacts_currency_guard
  before update of currency_code on contacts
  for each row execute function tohyee_guard_contact_currency();

-- A foreign-currency document keeps its exchange rate (base currency per 1
-- unit, up to 8 decimal places) and its base-currency amounts: each line
-- converted on its own and rounded once, the totals the sum of the lines
-- (NetSuite converts line by line). A base-currency document has none.
alter table sales_invoices
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_subtotal numeric, add column base_tax_total numeric, add column base_total numeric;
alter table bills
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_subtotal numeric, add column base_tax_total numeric, add column base_total numeric;
alter table sales_credit_notes
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_subtotal numeric, add column base_tax_total numeric, add column base_total numeric;
alter table supplier_credit_notes
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_subtotal numeric, add column base_tax_total numeric, add column base_total numeric;
alter table sales_invoices add constraint sales_invoices_base_check check (
  (exchange_rate is null and base_subtotal is null and base_tax_total is null and base_total is null)
  or (exchange_rate is not null and base_total = base_subtotal + base_tax_total and base_total > 0));
alter table bills add constraint bills_base_check check (
  (exchange_rate is null and base_subtotal is null and base_tax_total is null and base_total is null)
  or (exchange_rate is not null and base_total = base_subtotal + base_tax_total and base_total > 0));
alter table sales_credit_notes add constraint sales_credit_notes_base_check check (
  (exchange_rate is null and base_subtotal is null and base_tax_total is null and base_total is null)
  or (exchange_rate is not null and base_total = base_subtotal + base_tax_total and base_total > 0));
alter table supplier_credit_notes add constraint supplier_credit_notes_base_check check (
  (exchange_rate is null and base_subtotal is null and base_tax_total is null and base_total is null)
  or (exchange_rate is not null and base_total = base_subtotal + base_tax_total and base_total > 0));
alter table sales_invoice_lines add column base_net_amount numeric, add column base_tax_amount numeric;
alter table bill_lines add column base_net_amount numeric, add column base_tax_amount numeric;
alter table sales_credit_note_lines add column base_net_amount numeric, add column base_tax_amount numeric;
alter table supplier_credit_note_lines add column base_net_amount numeric, add column base_tax_amount numeric;

-- A document is in its contact's currency, and has a rate exactly when that
-- isn't the base currency.
create function tohyee_check_document_currency() returns trigger
language plpgsql as $$
declare
  wanted text;
begin
  select coalesce(c.currency_code, s.base_currency) into wanted
    from contacts c cross join organisation_settings s where c.id = new.contact_id;
  if wanted is not null and new.currency_code <> wanted then
    raise exception 'This contact''s documents are in %, not %', wanted, new.currency_code using errcode = '23514';
  end if;
  if (new.currency_code = (select base_currency from organisation_settings)) <> (new.exchange_rate is null) then
    raise exception 'A document has an exchange rate exactly when it isn''t in the base currency' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger sales_invoices_currency_check before insert or update of contact_id, currency_code, exchange_rate on sales_invoices
  for each row execute function tohyee_check_document_currency();
create trigger bills_currency_check before insert or update of contact_id, currency_code, exchange_rate on bills
  for each row execute function tohyee_check_document_currency();
create trigger sales_credit_notes_currency_check before insert or update of contact_id, currency_code, exchange_rate on sales_credit_notes
  for each row execute function tohyee_check_document_currency();
create trigger supplier_credit_notes_currency_check before insert or update of contact_id, currency_code, exchange_rate on supplier_credit_notes
  for each row execute function tohyee_check_document_currency();

-- A payment of a foreign-currency invoice or bill keeps its own rate, the
-- base amount that moved in the bank account (amount x rate, rounded once),
-- the base amount it cleared from accounts receivable or payable (the
-- document's carrying value of what it paid) and the realised gain (a loss
-- is negative), like NetSuite's realized gain/loss.
alter table customer_payments
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric, add column base_cleared numeric, add column realised_gain numeric;
alter table customer_payments add constraint customer_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_amount - base_cleared
      and overpayment_amount = 0 and batch_id is null));
alter table supplier_payments
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric, add column base_cleared numeric, add column realised_gain numeric;
alter table supplier_payments add constraint supplier_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_cleared - base_amount
      and batch_id is null));

-- Credit applied between two foreign-currency documents clears each at its
-- own carrying value; the difference is a realised gain or loss, posted in
-- its own journal (NetSuite's realized gain/loss on applying a credit).
alter table sales_credit_note_applications
  add column invoice_base numeric, add column credit_note_base numeric, add column realised_gain numeric,
  add column journal_id bigint references ledger_journals(id);
alter table sales_credit_note_applications add constraint sales_credit_note_applications_base_check check (
  (invoice_base is null and credit_note_base is null and realised_gain is null and journal_id is null)
  or (invoice_base > 0 and credit_note_base > 0 and realised_gain = credit_note_base - invoice_base
      and (journal_id is null) = (realised_gain = 0)));
alter table supplier_credit_note_applications
  add column bill_base numeric, add column credit_note_base numeric, add column realised_gain numeric,
  add column journal_id bigint references ledger_journals(id);
alter table supplier_credit_note_applications add constraint supplier_credit_note_applications_base_check check (
  (bill_base is null and credit_note_base is null and realised_gain is null and journal_id is null)
  or (bill_base > 0 and credit_note_base > 0 and realised_gain = bill_base - credit_note_base
      and (journal_id is null) = (realised_gain = 0)));

-- Accounts receivable and payable stay in the base currency, but, like
-- NetSuite's A/R and A/P accounts, hold foreign-currency documents too: a
-- line for one has its foreign amount and currency. fx_kind 'document' is a
-- document's own line (base = its lines converted one by one; the rate is the
-- document's); a payment or credit clearing it is 'carrying_value' (the
-- document's carrying value of what's cleared); revaluations as before.
alter table ledger_journal_lines drop constraint ledger_journal_lines_fx_kind_check;
alter table ledger_journal_lines add constraint ledger_journal_lines_fx_kind_check
  check (fx_kind in ('rate', 'implied', 'carrying_value', 'revaluation', 'document'));

create or replace function tohyee_check_foreign_line() returns trigger
language plpgsql as $$
declare
  account record;
  base text;
  posted date;
  opening record;
  latest_out date;
begin
  select a.code, a.name, a.currency_code, a.system_key into account from accounts a where a.id = new.account_id;
  select base_currency into base from organisation_settings;
  if account.currency_code is null or account.currency_code = base then
    if new.foreign_currency_code is not null then
      if account.system_key not in ('accounts_receivable', 'accounts_payable') then
        raise exception 'Account % (%) is in %, so its journal lines have no foreign amount', account.code, account.name,
          coalesce(base, 'the base currency') using errcode = '23514';
      end if;
      if new.foreign_currency_code = base then
        raise exception 'Account % (%): a foreign amount can''t be in the base currency', account.code, account.name
          using errcode = '23514';
      end if;
      if new.fx_kind not in ('document', 'carrying_value', 'revaluation') then
        raise exception 'Account % (%) only takes foreign amounts from invoices, bills, credit notes, their payments and revaluations',
          account.code, account.name using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if new.fx_kind = 'document' then
    raise exception 'Account % (%) is a foreign-currency account, not accounts receivable or payable', account.code, account.name
      using errcode = '23514';
  end if;
  if new.foreign_currency_code is null then
    raise exception 'Account % (%) is in %: its journal lines need the % amount and exchange rate as well as the % amount',
      account.code, account.name, account.currency_code, account.currency_code, coalesce(base, 'base') using errcode = '23514';
  end if;
  if new.foreign_currency_code <> account.currency_code then
    raise exception 'Account % (%) is in %, not %', account.code, account.name, account.currency_code, new.foreign_currency_code
      using errcode = '23514';
  end if;
  if new.fx_kind = 'rate'
     and round(new.foreign_amount * new.exchange_rate, case when base in ('JPY', 'XPF') then 0 else 2 end)
         <> new.debit_amount + new.credit_amount then
    raise exception 'On account %, % % at % is %, not %', account.code, account.currency_code, new.foreign_amount,
      new.exchange_rate, round(new.foreign_amount * new.exchange_rate, 2), new.debit_amount + new.credit_amount
      using errcode = '23514';
  end if;
  select posting_date into posted from ledger_journals where id = new.journal_id;
  select * into opening from ledger_foreign_opening_balances where account_id = new.account_id;
  if found then
    if posted <= opening.as_at_date then
      raise exception 'Account % (%) has an opening foreign balance as at %, so nothing can be posted to it dated on or before then',
        account.code, account.name, opening.as_at_date using errcode = '23514';
    end if;
  elsif new.fx_kind <> 'revaluation'
        and exists (select 1 from ledger_journal_lines where account_id = new.account_id and foreign_amount is null) then
    raise exception 'Account % (%) has postings from before Tohyee kept foreign amounts. Enter its % balance as at a date (its opening foreign balance) first',
      account.code, account.name, account.currency_code using errcode = '23514';
  end if;
  select max(j.posting_date) into latest_out
    from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
   where l.account_id = new.account_id and l.fx_kind = 'carrying_value' and l.credit_amount > 0;
  if latest_out is not null and posted < latest_out and new.fx_kind <> 'revaluation' then
    raise exception 'Account % (%) had money transferred out on %, at its carrying value; nothing can be posted to it dated before then',
      account.code, account.name, latest_out using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Revaluing open foreign-currency balances on accounts receivable and
-- payable (NetSuite's revaluation of open currency balances): one item per
-- account and currency on a date. Their balance can be either sign.
alter table ledger_fx_revaluation_run_items drop constraint ledger_fx_revaluation_run_items_account_id_revaluation_date_key;
alter table ledger_fx_revaluation_run_items add constraint ledger_fx_revaluation_run_items_account_currency_date_key
  unique (account_id, currency_code, revaluation_date);
alter table ledger_fx_revaluation_run_items drop constraint ledger_fx_revaluation_run_items_foreign_amount_check;
alter table ledger_fx_revaluation_run_items add constraint ledger_fx_revaluation_run_items_foreign_amount_check
  check (foreign_amount <> 0);
`,
  };
