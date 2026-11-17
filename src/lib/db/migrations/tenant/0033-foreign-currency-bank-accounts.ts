import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0033",
    name: "foreign_currency_bank_accounts",
    sql: `
-- Foreign-currency bank accounts (examples FXB1-FXB11). Following NetSuite,
-- journal lines on a foreign-currency account keep both amounts: the NZD
-- (base) debit or credit as before, plus the foreign amount on the same side
-- and the exchange rate (base currency per 1 unit, up to 8 decimal places).
-- fx_kind says how the base amount was worked out:
--   'rate'           base = foreign x rate, rounded once to the base currency's units
--   'implied'        base given (money moved in from a base account); rate = base / foreign, for information
--   'carrying_value' money leaving at the account's carrying value (a transfer out); rate for information
--   'revaluation'    an FX revaluation (or its reversal): foreign amount 0, rate the closing rate
-- Lines posted before this migration have none of these, even on
-- foreign-currency accounts; such an account needs an opening foreign balance
-- (below) before it takes anything new.
alter table ledger_journal_lines
  add column foreign_currency_code text check (foreign_currency_code ~ '^[A-Z]{3}$'),
  add column foreign_amount numeric check (foreign_amount >= 0 and scale(foreign_amount) <= 4),
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column fx_kind text check (fx_kind in ('rate', 'implied', 'carrying_value', 'revaluation'));
alter table ledger_journal_lines add constraint ledger_journal_lines_foreign_check check (
  (foreign_currency_code is null and foreign_amount is null and exchange_rate is null and fx_kind is null)
  or (foreign_currency_code is not null and foreign_amount is not null and exchange_rate is not null and fx_kind is not null
      and (fx_kind = 'revaluation') = (foreign_amount = 0))
);
-- The line's amount in its account's currency, signed like a statement line
-- (debits positive): what statement lines are reconciled against.
alter table ledger_journal_lines add column account_amount numeric generated always as (
  case when foreign_amount is null then debit_amount - credit_amount
       when debit_amount > 0 then foreign_amount
       else -foreign_amount end
) stored;
create index ledger_journal_lines_foreign_idx on ledger_journal_lines (account_id) where foreign_amount is not null;
create index ledger_journal_lines_base_only_idx on ledger_journal_lines (account_id) where foreign_amount is null;

-- Whether an account is in a currency other than the organisation's base.
create function tohyee_is_foreign_account(target bigint) returns boolean
language sql stable as $$
  select a.currency_code is not null
         and a.currency_code is distinct from (select base_currency from organisation_settings)
    from accounts a where a.id = target
$$;

-- The foreign balance of a foreign-currency account that already had
-- base-only postings, entered once as at a date (FXB1). It posts nothing: it
-- says what the account's base balance at that date is in the foreign
-- currency. Never changed or deleted.
create table ledger_foreign_opening_balances (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  account_id bigint not null unique references accounts(id),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  as_at_date date not null,
  foreign_balance numeric not null,
  base_balance numeric not null,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (sign(foreign_balance) = sign(base_balance))
);
create trigger ledger_foreign_opening_balances_append_only
  before update or delete on ledger_foreign_opening_balances
  for each row execute function toeyee_forbid_mutation();
create trigger ledger_foreign_opening_balances_no_truncate
  before truncate on ledger_foreign_opening_balances
  for each statement execute function toeyee_forbid_mutation();

create function tohyee_check_foreign_opening_balance() returns trigger
language plpgsql as $$
declare
  account record;
  base_total numeric;
begin
  select a.code, a.currency_code into account from accounts a where a.id = new.account_id;
  if not tohyee_is_foreign_account(new.account_id) or account.currency_code <> new.currency_code then
    raise exception 'Account % isn''t in %, so it has no opening foreign balance', account.code, new.currency_code
      using errcode = '23514';
  end if;
  if not exists (select 1 from ledger_journal_lines where account_id = new.account_id and foreign_amount is null) then
    raise exception 'Account % has no postings from before Tohyee kept foreign amounts, so it doesn''t need an opening foreign balance',
      account.code using errcode = '23514';
  end if;
  if exists (select 1 from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
              where l.account_id = new.account_id
                and (j.posting_date > new.as_at_date or l.foreign_amount is not null)) then
    raise exception 'Account % has postings after %, so its opening foreign balance can''t be as at that date',
      account.code, new.as_at_date using errcode = '23514';
  end if;
  select coalesce(sum(l.debit_amount - l.credit_amount), 0) into base_total
    from ledger_journal_lines l where l.account_id = new.account_id;
  if base_total <> new.base_balance then
    raise exception 'Account %''s balance on % is %, not %', account.code, new.as_at_date, base_total, new.base_balance
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger ledger_foreign_opening_balances_check
  before insert on ledger_foreign_opening_balances
  for each row execute function tohyee_check_foreign_opening_balance();

-- Every line posted from now on: a line on a foreign-currency account has a
-- foreign amount in the account's currency; a line on a base-currency
-- account has none. A line at a rate has base = foreign x rate, rounded once.
-- A foreign-currency account with base-only postings takes nothing new but
-- revaluations (whose foreign balance is then typed) until its opening
-- foreign balance is entered, and then nothing dated on or before it. Nothing but a revaluation is posted to a foreign-currency account dated
-- before its latest transfer out (money that left at its carrying value).
create function tohyee_check_foreign_line() returns trigger
language plpgsql as $$
declare
  account record;
  base text;
  posted date;
  opening record;
  latest_out date;
begin
  select a.code, a.name, a.currency_code into account from accounts a where a.id = new.account_id;
  select base_currency into base from organisation_settings;
  if account.currency_code is null or account.currency_code = base then
    if new.foreign_currency_code is not null then
      raise exception 'Account % (%) is in %, so its journal lines have no foreign amount', account.code, account.name,
        coalesce(base, 'the base currency') using errcode = '23514';
    end if;
    return new;
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
create trigger ledger_journal_lines_foreign_check
  before insert on ledger_journal_lines
  for each row execute function tohyee_check_foreign_line();

-- An account's currency can't change once it has postings (the app refused it
-- already; now the database does too), since its lines' foreign amounts are
-- in that currency.
create function tohyee_guard_account_currency() returns trigger
language plpgsql as $$
begin
  if new.currency_code is distinct from old.currency_code
     and exists (select 1 from ledger_journal_lines where account_id = old.id) then
    raise exception 'Account % has postings, so its currency can''t change', old.code using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger accounts_currency_guard
  before update of currency_code on accounts
  for each row execute function tohyee_guard_account_currency();

-- Statement lines record their currency (the file's, or the account's). Lines
-- from before this have none and are in the base currency.
alter table bank_statement_lines add column currency_code text check (currency_code ~ '^[A-Z]{3}$');
create function tohyee_check_statement_line_currency() returns trigger
language plpgsql as $$
declare
  account_currency text;
begin
  select coalesce(a.currency_code, s.base_currency) into account_currency
    from accounts a cross join organisation_settings s where a.id = new.account_id;
  if new.currency_code is null or new.currency_code is distinct from account_currency then
    raise exception 'Statement lines on this account are in %, not %', account_currency, coalesce(new.currency_code, 'no currency')
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger bank_statement_lines_currency_check
  before insert on bank_statement_lines
  for each row execute function tohyee_check_statement_line_currency();

-- Spend and receive money on a foreign-currency account: amounts are in the
-- account's currency, with the rate and each line's base amounts (what the
-- GST return and project costs count).
alter table bank_transactions
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_total numeric check (base_total > 0);
alter table bank_transactions add constraint bank_transactions_foreign_check
  check ((exchange_rate is null) = (base_total is null));
alter table bank_transaction_lines
  add column base_line_amount numeric check (base_line_amount >= 0),
  add column base_net_amount numeric check (base_net_amount >= 0),
  add column base_tax_amount numeric check (base_tax_amount >= 0);
alter table bank_transaction_lines add constraint bank_transaction_lines_base_check check (
  (base_line_amount is null and base_net_amount is null and base_tax_amount is null)
  or (base_line_amount is not null and base_net_amount is not null and base_tax_amount is not null
      and base_line_amount = base_net_amount + base_tax_amount)
);

-- Transfers between a base-currency account and a foreign-currency one: the
-- amount in the other account's currency, and for money leaving a foreign
-- account its carrying value and the realised gain (negative for a loss).
alter table bank_transfers
  add column to_currency_code text check (to_currency_code ~ '^[A-Z]{3}$'),
  add column to_amount numeric check (to_amount > 0),
  add column carrying_amount numeric check (carrying_amount >= 0),
  add column realised_gain numeric;
alter table bank_transfers add constraint bank_transfers_foreign_check
  check ((to_currency_code is null) = (to_amount is null));

-- Statement lines on foreign-currency accounts are reconciled against their
-- journal lines' foreign amounts (account_amount); lines kept only in the
-- base currency can't be. Otherwise as before (0032).
create or replace function tohyee_check_reconciliation(target bigint) returns void
language plpgsql as $$
declare
  rec record;
  line record;
  split record;
  total numeric;
  wrong integer;
  foreign_line boolean;
begin
  select * into rec from bank_reconciliations where id = target;
  if not found then
    return;
  end if;
  select * into line from bank_statement_lines where id = rec.statement_line_id;
  foreign_line := tohyee_is_foreign_account(line.account_id);
  if rec.status = 'active' then
    if line.status <> 'reconciled' then
      raise exception 'Statement line % has a reconciliation but isn''t marked reconciled', line.id using errcode = '23514';
    end if;
    select coalesce(sum(i.amount), 0),
           count(*) filter (
             where j.account_id <> line.account_id
                or (foreign_line and j.foreign_amount is null)
                or i.split_id is distinct from rec.split_id
                or (i.split_id is null and i.amount <> j.account_amount)
                or (i.split_id is null and exists (
                      select 1 from bank_reconciliation_items o
                       where o.active and o.journal_line_id = i.journal_line_id and o.id <> i.id))
                or (i.split_id is not null and (sign(i.amount) <> sign(j.account_amount)
                      or abs(i.amount) >= abs(j.account_amount))))
      into total, wrong
      from bank_reconciliation_items i join ledger_journal_lines j on j.id = i.journal_line_id
     where i.reconciliation_id = rec.id;
    if wrong > 0 then
      raise exception 'Statement line % is reconciled against journal lines on another account or with other amounts', line.id
        using errcode = '23514';
    end if;
    if total <> line.amount then
      raise exception 'Statement line % (%) is reconciled against journal lines adding up to %', line.id, line.amount, total
        using errcode = '23514';
    end if;
    if rec.split_id is not null then
      select s.id, s.account_id, s.journal_line_id, j.account_amount as journal_amount into split
        from bank_reconciliation_splits s join ledger_journal_lines j on j.id = s.journal_line_id
       where s.id = rec.split_id;
      if split.account_id <> line.account_id
         or exists (select 1 from bank_reconciliation_items i
                     where i.reconciliation_id = rec.id and i.journal_line_id <> split.journal_line_id)
         or exists (select 1 from bank_reconciliations r where r.split_id = split.id and r.status <> 'active')
         or (select count(*) from bank_reconciliations r where r.split_id = split.id) < 2
         or exists (select 1 from bank_reconciliation_items i
                     where i.active and i.journal_line_id = split.journal_line_id and i.split_id is distinct from split.id)
         or (select coalesce(sum(i.amount), 0) from bank_reconciliation_items i
              where i.active and i.split_id = split.id) <> split.journal_amount then
        raise exception 'Split reconciliation % doesn''t add up to its journal line, or isn''t reconciled as a whole', split.id
          using errcode = '23514';
      end if;
    end if;
  else
    if line.status = 'reconciled'
       and not exists (select 1 from bank_reconciliations where statement_line_id = line.id and status = 'active') then
      raise exception 'Statement line % is marked reconciled without a reconciliation', line.id using errcode = '23514';
    end if;
    if rec.split_id is not null
       and exists (select 1 from bank_reconciliations r where r.split_id = rec.split_id and r.status = 'active') then
      raise exception 'Split reconciliation % is only partly unreconciled; unreconcile all its lines together', rec.split_id
        using errcode = '23514';
    end if;
  end if;
end;
$$;

-- Realised currency gains and losses (FXB5, FXB8) go to the account marked
-- for them: 7020 in the starting chart, or that code or the next free one.
update accounts set system_key = 'realised_fx', updated_at = now()
 where lower(code) = '7020' and account_class = 'revenue' and system_key is null and currency_code is null
   and not exists (select 1 from accounts where system_key = 'realised_fx');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(7020, 7999) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Realised currency gains and losses', 'revenue', 'other_income', 'realised_fx'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'realised_fx');
`,
  };
