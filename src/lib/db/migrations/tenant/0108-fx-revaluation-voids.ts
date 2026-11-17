import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0108",
    name: "fx_revaluation_voids",
    sql: `
-- Voiding an FX revaluation (example FXB12, issue #151): the run is kept and
-- a void is recorded beside it (append-only, once per run), with the
-- journals reversing its revaluation journal (dated the revaluation date)
-- and its reversal journal (dated the reversal date), and who voided it.
-- A voided revaluation no longer counts anywhere a revaluation is looked up.
create table ledger_fx_revaluation_voids (
  id bigserial primary key,
  run_id bigint not null unique references ledger_fx_revaluation_runs(id),
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  void_journal_id bigint not null references ledger_journals(id),
  void_reversal_journal_id bigint not null references ledger_journals(id),
  voided_by_user_id uuid,
  voided_by_email text not null,
  voided_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create trigger ledger_fx_revaluation_voids_append_only
  before update or delete on ledger_fx_revaluation_voids
  for each row execute function toeyee_forbid_mutation();
create trigger ledger_fx_revaluation_voids_no_truncate
  before truncate on ledger_fx_revaluation_voids
  for each statement execute function toeyee_forbid_mutation();

-- One revaluation per account, currency and date, not counting voided ones
-- (so a voided revaluation's date can be revalued again). The unique
-- constraint can't see voids, so a trigger checks it, under a lock per
-- account, currency and date.
alter table ledger_fx_revaluation_run_items drop constraint ledger_fx_revaluation_run_items_account_currency_date_key;
create index ledger_fx_revaluation_run_items_account_idx on ledger_fx_revaluation_run_items (account_id, currency_code, revaluation_date);
create function tohyee_check_fx_revaluation_item() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'tohyee_fx_revaluation_item:' || new.account_id || ':' || new.currency_code || ':' || new.revaluation_date, 0));
  if exists (select 1 from ledger_fx_revaluation_run_items i
              where i.account_id = new.account_id and i.currency_code = new.currency_code
                and i.revaluation_date = new.revaluation_date
                and not exists (select 1 from ledger_fx_revaluation_voids v where v.run_id = i.run_id)) then
    raise exception 'Account % (%) has already been revalued on %', new.account_id, new.currency_code, new.revaluation_date
      using errcode = '23505';
  end if;
  return new;
end;
$$;
create trigger ledger_fx_revaluation_run_items_unique_check
  before insert on ledger_fx_revaluation_run_items
  for each row execute function tohyee_check_fx_revaluation_item();

-- A transfer out of a foreign-currency account (a carrying-value credit)
-- can't be dated before the reversal date of a revaluation of the account
-- that isn't voided (FXB12): its carrying value would include the
-- unrealised amount, and the reversal would then hit money that had gone.
create or replace function tohyee_check_foreign_line() returns trigger
language plpgsql as $$
declare
  account record;
  base text;
  posted date;
  opening record;
  latest_out date;
  spanning record;
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
  if new.fx_kind = 'carrying_value' and new.credit_amount > 0 then
    select r.reference, r.revaluation_date, r.reversal_posting_date into spanning
      from ledger_fx_revaluation_run_items i join ledger_fx_revaluation_runs r on r.id = i.run_id
     where i.account_id = new.account_id and r.reversal_posting_date > posted
       and not exists (select 1 from ledger_fx_revaluation_voids v where v.run_id = r.id)
     order by r.reversal_posting_date desc limit 1;
    if found then
      raise exception '% (%) was revalued on % (%), and that isn''t reversed until %. A transfer out dated before then isn''t supported',
        account.code, account.name, spanning.revaluation_date, spanning.reference, spanning.reversal_posting_date
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
`,
  };
