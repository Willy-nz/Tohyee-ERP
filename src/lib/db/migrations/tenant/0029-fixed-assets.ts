import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0029",
    name: "fixed_assets",
    sql: `
-- Fixed assets (examples FA1-FA14), like Xero's fixed asset register. Asset
-- types say which accounts an asset's cost, accumulated depreciation and
-- depreciation expense are on, with a default method and rate the
-- organisation types in (Tohyee has no built-in IRD rates). Registering an
-- asset posts nothing: its cost is already in the ledger (from a bill, a
-- bank transaction or an opening journal). A depreciation run posts one
-- journal (Dr depreciation / Cr accumulated depreciation); the latest run can
-- be rolled back with the exact reversal. A disposal posts depreciation up to
-- the disposal, takes the cost and accumulated depreciation off, clears the
-- proceeds and posts the gain or loss; it can be undone with the exact
-- reversal. Nothing here is ever deleted.

-- Where gains and losses on disposals go by default. New organisations get
-- them with the starting chart (7030, 7040); existing ones get them here, at
-- that code or the next free one after it.
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(7030, 7999) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Gain or loss on disposal of fixed assets', 'revenue', 'other_income', 'fixed_asset_disposal'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'fixed_asset_disposal');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(7040, 7999) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Capital gains on disposal of fixed assets', 'revenue', 'other_income', 'fixed_asset_capital_gain'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'fixed_asset_capital_gain');

alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal'));

alter table record_notes drop constraint record_notes_record_type_check;
alter table record_notes add constraint record_notes_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset'));
alter table record_attachments drop constraint record_attachments_record_type_check;
alter table record_attachments add constraint record_attachments_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset'));

-- How part months are counted (FA7, FA8): the month an asset is bought
-- counts in full, or depreciation starts the month after; the month it's
-- disposed of counts in full, or isn't depreciated.
alter table organisation_settings
  add column fixed_asset_first_month text not null default 'full_month'
    check (fixed_asset_first_month in ('full_month', 'next_month')),
  add column fixed_asset_disposal_month text not null default 'exclude'
    check (fixed_asset_disposal_month in ('include', 'exclude'));

create table fixed_asset_types (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  asset_account_id bigint not null references accounts(id),
  accumulated_depreciation_account_id bigint not null references accounts(id),
  depreciation_expense_account_id bigint not null references accounts(id),
  method text not null check (method in ('dv', 'sl', 'none')),
  rate numeric check (rate is null or (rate > 0 and rate <= 100 and scale(rate) <= 4)),
  archived_at timestamptz,
  archived_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((method = 'none') = (rate is null)),
  check (asset_account_id <> accumulated_depreciation_account_id)
);
create unique index fixed_asset_types_name_key on fixed_asset_types (lower(name)) where archived_at is null;

create table fixed_asset_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into fixed_asset_numbering (id) values (true);
create trigger fixed_asset_numbering_guard
  before update or delete on fixed_asset_numbering
  for each row execute function toeyee_guard_invoice_numbering();
create trigger fixed_asset_numbering_no_truncate
  before truncate on fixed_asset_numbering
  for each statement execute function toeyee_guard_invoice_numbering();

create table fixed_assets (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  asset_number text not null unique check (asset_number ~ '^FA-[0-9]{4,}$'),
  name text not null check (length(name) between 1 and 200 and name = btrim(name)),
  description text check (description is null or length(description) between 1 and 1000),
  type_id bigint not null references fixed_asset_types(id),
  status text not null default 'registered' check (status in ('registered', 'disposed', 'archived')),
  purchase_date date not null,
  cost numeric not null check (cost > 0),
  -- Checked by tohyee_check_fixed_asset_bill_line (an approved bill's line,
  -- which can never be deleted) rather than a foreign key, so bill_lines keeps
  -- refusing TRUNCATE with its own message.
  bill_line_id bigint,
  method text not null check (method in ('dv', 'sl', 'none')),
  rate numeric check (rate is null or (rate > 0 and rate <= 100 and scale(rate) <= 4)),
  residual_value numeric not null default 0 check (residual_value >= 0),
  opening_date date,
  opening_accumulated_depreciation numeric not null default 0 check (opening_accumulated_depreciation >= 0),
  tracking jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  archived_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((method = 'none') = (rate is null)),
  check (residual_value <= cost),
  check (opening_accumulated_depreciation <= cost - residual_value),
  check (opening_date is not null or opening_accumulated_depreciation = 0),
  check (opening_date is null or (opening_date >= purchase_date
         and opening_date = (date_trunc('month', opening_date) + interval '1 month - 1 day')::date)),
  check ((status = 'archived') = (archived_at is not null))
);
create index fixed_assets_type_idx on fixed_assets (type_id);
create index fixed_assets_bill_line_idx on fixed_assets (bill_line_id) where bill_line_id is not null;
create trigger fixed_assets_tracking before insert or update on fixed_assets
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();

create table fixed_asset_depreciation_runs (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  period_end date not null check (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  status text not null default 'active' check (status in ('active', 'rolled_back')),
  total numeric not null check (total >= 0),
  journal_id bigint unique references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  rollback_journal_id bigint unique references ledger_journals(id),
  rollback_command_source text,
  rollback_idempotency_key text,
  rollback_request_hash text,
  rolled_back_by_user_id uuid,
  rolled_back_by_email text,
  rolled_back_at timestamptz,
  unique (command_source, idempotency_key),
  unique (rollback_command_source, rollback_idempotency_key),
  check ((total > 0) = (journal_id is not null)),
  check ((status = 'rolled_back') = (rolled_back_at is not null and rollback_idempotency_key is not null)),
  check (rollback_journal_id is null or journal_id is not null),
  check (status = 'active' or (journal_id is null) = (rollback_journal_id is null))
);
create unique index fixed_asset_depreciation_runs_active_period on fixed_asset_depreciation_runs (period_end) where status = 'active';

create table fixed_asset_disposals (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  asset_id bigint not null references fixed_assets(id),
  status text not null default 'active' check (status in ('active', 'undone')),
  disposal_date date not null,
  proceeds numeric not null default 0 check (proceeds >= 0),
  proceeds_account_id bigint references accounts(id),
  gain_loss_account_id bigint not null references accounts(id),
  capital_gain_account_id bigint not null references accounts(id),
  cost numeric not null check (cost > 0),
  depreciation numeric not null check (depreciation >= 0),
  accumulated_depreciation numeric not null check (accumulated_depreciation >= 0 and accumulated_depreciation <= cost),
  depreciation_recovered numeric not null check (depreciation_recovered >= 0),
  capital_gain numeric not null check (capital_gain >= 0),
  loss numeric not null check (loss >= 0),
  journal_id bigint not null unique references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  undo_journal_id bigint unique references ledger_journals(id),
  undo_command_source text,
  undo_idempotency_key text,
  undo_request_hash text,
  undone_by_user_id uuid,
  undone_by_email text,
  undone_at timestamptz,
  unique (command_source, idempotency_key),
  unique (undo_command_source, undo_idempotency_key),
  check ((proceeds = 0) = (proceeds_account_id is null)),
  -- Book value plus the gain, less the loss, is what it sold for.
  check (cost - accumulated_depreciation + depreciation_recovered + capital_gain - loss = proceeds),
  check (loss = 0 or (depreciation_recovered = 0 and capital_gain = 0)),
  check (depreciation_recovered <= accumulated_depreciation),
  check ((status = 'undone') = (undo_journal_id is not null and undone_at is not null))
);
create unique index fixed_asset_disposals_active_asset on fixed_asset_disposals (asset_id) where status = 'active';

-- Depreciation charged to an asset, one row per asset per financial year a
-- run (or a disposal) covers. Rows never change: a rolled back run or an
-- undone disposal takes its rows out of the count.
create table fixed_asset_depreciation_lines (
  id bigserial primary key,
  run_id bigint references fixed_asset_depreciation_runs(id),
  disposal_id bigint references fixed_asset_disposals(id),
  asset_id bigint not null references fixed_assets(id),
  financial_year_start date not null,
  from_month date not null check (extract(day from from_month) = 1),
  to_month date not null check (extract(day from to_month) = 1),
  months integer not null check (months > 0),
  amount numeric not null check (amount >= 0),
  check (num_nonnulls(run_id, disposal_id) = 1),
  check (to_month >= from_month and from_month >= financial_year_start)
);
create unique index fixed_asset_depreciation_lines_run on fixed_asset_depreciation_lines (run_id, asset_id, financial_year_start) where run_id is not null;
create unique index fixed_asset_depreciation_lines_disposal on fixed_asset_depreciation_lines (disposal_id, financial_year_start) where disposal_id is not null;
create index fixed_asset_depreciation_lines_asset on fixed_asset_depreciation_lines (asset_id);

-- Whether an asset has depreciation or a disposal that counts.
create function tohyee_fixed_asset_has_history(asset bigint) returns boolean
language sql stable as $$
  select exists (select 1 from fixed_asset_depreciation_lines l
                   left join fixed_asset_depreciation_runs r on r.id = l.run_id
                   left join fixed_asset_disposals d on d.id = l.disposal_id
                  where l.asset_id = asset and (r.status = 'active' or d.status = 'active'))
      or exists (select 1 from fixed_asset_disposals d where d.asset_id = asset and d.status = 'active');
$$;

-- Types are archived, never deleted; their accounts can't change once an
-- asset uses the type (its cost and depreciation are already on them).
create function tohyee_guard_fixed_asset_type() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'fixed_asset_types can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Asset types can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if (new.asset_account_id, new.accumulated_depreciation_account_id, new.depreciation_expense_account_id)
       is distinct from (old.asset_account_id, old.accumulated_depreciation_account_id, old.depreciation_expense_account_id)
     and exists (select 1 from fixed_assets where type_id = old.id and status <> 'archived') then
    raise exception 'Asset type % has assets, so its accounts can''t change', old.name using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger fixed_asset_types_guard before update or delete on fixed_asset_types
  for each row execute function tohyee_guard_fixed_asset_type();
create trigger fixed_asset_types_no_truncate before truncate on fixed_asset_types
  for each statement execute function tohyee_guard_fixed_asset_type();

-- An asset from a bill line: an approved bill's line on the type's asset
-- account, and the assets from one line never cost more than the line's
-- amount excluding GST (FA2).
create function tohyee_check_fixed_asset_bill_line() returns trigger
language plpgsql as $$
declare
  line record;
  registered numeric;
  asset_account bigint;
begin
  if new.bill_line_id is null or new.status = 'archived' then
    return new;
  end if;
  select l.net_amount, l.account_id, b.status into line from bill_lines l join bills b on b.id = l.bill_id where l.id = new.bill_line_id;
  if line.status is distinct from 'approved' then
    raise exception 'An asset can only come from an approved bill''s line' using errcode = 'P0001';
  end if;
  select asset_account_id into asset_account from fixed_asset_types where id = new.type_id;
  if line.account_id <> asset_account then
    raise exception 'An asset from a bill line must be on its asset type''s asset account' using errcode = 'P0001';
  end if;
  select coalesce(sum(cost), 0) into registered from fixed_assets
   where bill_line_id = new.bill_line_id and status <> 'archived';
  if registered > line.net_amount then
    raise exception 'Assets from one bill line can''t cost more than the line (%)', line.net_amount using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger fixed_assets_bill_line after insert or update on fixed_assets
  for each row execute function tohyee_check_fixed_asset_bill_line();

-- Assets are never deleted. Once depreciated or disposed of, only the name,
-- description and tracking change; archiving is only for assets with no
-- depreciation or disposal; an archived asset never changes; the status
-- follows its disposal (FA2, FA14).
create function tohyee_guard_fixed_asset() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'fixed_assets can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Fixed assets can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if old.status = 'archived' then
    raise exception 'Fixed asset % is archived and can''t change', old.asset_number using errcode = 'P0001';
  end if;
  if new.asset_number <> old.asset_number then
    raise exception 'A fixed asset''s number never changes' using errcode = 'P0001';
  end if;
  if new.status = 'archived' and tohyee_fixed_asset_has_history(old.id) then
    raise exception 'Fixed asset % has depreciation or a disposal, so it can''t be archived', old.asset_number using errcode = 'P0001';
  end if;
  if new.status = 'disposed' and old.status <> 'disposed'
     and not exists (select 1 from fixed_asset_disposals where asset_id = old.id and status = 'active') then
    raise exception 'Fixed asset % is only disposed of by recording its disposal', old.asset_number using errcode = 'P0001';
  end if;
  if new.status <> 'disposed' and exists (select 1 from fixed_asset_disposals where asset_id = old.id and status = 'active') then
    raise exception 'Fixed asset % has been disposed of; undo the disposal first', old.asset_number using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - array['name', 'description', 'tracking', 'status', 'archived_at', 'archived_by_email', 'updated_at'])
       <> (to_jsonb(old) - array['name', 'description', 'tracking', 'status', 'archived_at', 'archived_by_email', 'updated_at'])
     and tohyee_fixed_asset_has_history(old.id) then
    raise exception 'Fixed asset % has depreciation or a disposal, so only its name, description and tracking can change', old.asset_number
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger fixed_assets_guard before update or delete on fixed_assets
  for each row execute function tohyee_guard_fixed_asset();
create trigger fixed_assets_no_truncate before truncate on fixed_assets
  for each statement execute function tohyee_guard_fixed_asset();

-- Runs go forward: each is after the latest active run (FA4). Only the
-- latest active run can be rolled back, once, and not while an asset it
-- depreciated has an active disposal (FA5, FA11).
create function tohyee_check_depreciation_run() returns trigger
language plpgsql as $$
declare
  latest date;
begin
  if new.status <> 'active' then
    raise exception 'A depreciation run is recorded as active' using errcode = 'P0001';
  end if;
  select max(period_end) into latest from fixed_asset_depreciation_runs where status = 'active';
  if latest is not null and new.period_end <= latest then
    raise exception 'Depreciation has already been run to %; a new run must be to a later month end', latest using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger fixed_asset_depreciation_runs_check before insert on fixed_asset_depreciation_runs
  for each row execute function tohyee_check_depreciation_run();

create function tohyee_guard_depreciation_run() returns trigger
language plpgsql as $$
declare
  blocking text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'fixed_asset_depreciation_runs can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Depreciation runs can''t be deleted; roll them back instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'rolled_back'
     and (to_jsonb(new) - array['status', 'rollback_journal_id', 'rollback_command_source', 'rollback_idempotency_key',
            'rollback_request_hash', 'rolled_back_by_user_id', 'rolled_back_by_email', 'rolled_back_at'])
       = (to_jsonb(old) - array['status', 'rollback_journal_id', 'rollback_command_source', 'rollback_idempotency_key',
            'rollback_request_hash', 'rolled_back_by_user_id', 'rolled_back_by_email', 'rolled_back_at']) then
    if exists (select 1 from fixed_asset_depreciation_runs where status = 'active' and period_end > old.period_end) then
      raise exception 'Only the latest depreciation run can be rolled back' using errcode = 'P0001';
    end if;
    select a.asset_number into blocking
      from fixed_asset_depreciation_lines l
      join fixed_asset_disposals d on d.asset_id = l.asset_id and d.status = 'active'
      join fixed_assets a on a.id = l.asset_id
     where l.run_id = old.id
     order by a.asset_number limit 1;
    if blocking is not null then
      raise exception 'Undo the disposal of % first: it was worked out from this run', blocking using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Depreciation runs can''t be changed, only rolled back once' using errcode = 'P0001';
end;
$$;
create trigger fixed_asset_depreciation_runs_guard before update or delete on fixed_asset_depreciation_runs
  for each row execute function tohyee_guard_depreciation_run();
create trigger fixed_asset_depreciation_runs_no_truncate before truncate on fixed_asset_depreciation_runs
  for each statement execute function tohyee_guard_depreciation_run();

create function tohyee_guard_depreciation_line() returns trigger
language plpgsql as $$
begin
  raise exception 'Depreciation lines can''t be changed or deleted' using errcode = 'P0001';
end;
$$;
create trigger fixed_asset_depreciation_lines_guard before update or delete on fixed_asset_depreciation_lines
  for each row execute function tohyee_guard_depreciation_line();
create trigger fixed_asset_depreciation_lines_no_truncate before truncate on fixed_asset_depreciation_lines
  for each statement execute function tohyee_guard_depreciation_line();

-- A disposal is of a registered asset, after the latest depreciation run
-- (the run would otherwise have depreciated months after it), on or after
-- the purchase date and after any opening balance date (FA8).
create function tohyee_check_fixed_asset_disposal() returns trigger
language plpgsql as $$
declare
  asset record;
  latest date;
begin
  if new.status <> 'active' then
    raise exception 'A disposal is recorded as active' using errcode = 'P0001';
  end if;
  select id, asset_number, status, purchase_date, opening_date, cost into asset from fixed_assets where id = new.asset_id for update;
  if asset.status <> 'registered' then
    raise exception 'Fixed asset % is %, so it can''t be disposed of', asset.asset_number, asset.status using errcode = 'P0001';
  end if;
  if new.disposal_date < asset.purchase_date or (asset.opening_date is not null and new.disposal_date <= asset.opening_date) then
    raise exception 'Fixed asset % can''t be disposed of before it was bought or its opening balance date', asset.asset_number
      using errcode = 'P0001';
  end if;
  select max(period_end) into latest from fixed_asset_depreciation_runs where status = 'active';
  if latest is not null and new.disposal_date <= latest then
    raise exception 'Depreciation has been run to %, so a disposal must be after it. Roll the run back first', latest using errcode = 'P0001';
  end if;
  if new.cost <> asset.cost then
    raise exception 'A disposal takes off the asset''s whole cost' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger fixed_asset_disposals_check before insert on fixed_asset_disposals
  for each row execute function tohyee_check_fixed_asset_disposal();

create function tohyee_guard_fixed_asset_disposal() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'fixed_asset_disposals can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Disposals can''t be deleted; undo them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'undone'
     and (to_jsonb(new) - array['status', 'undo_journal_id', 'undo_command_source', 'undo_idempotency_key', 'undo_request_hash',
            'undone_by_user_id', 'undone_by_email', 'undone_at'])
       = (to_jsonb(old) - array['status', 'undo_journal_id', 'undo_command_source', 'undo_idempotency_key', 'undo_request_hash',
            'undone_by_user_id', 'undone_by_email', 'undone_at']) then
    return new;
  end if;
  raise exception 'Disposals can''t be changed, only undone once' using errcode = 'P0001';
end;
$$;
create trigger fixed_asset_disposals_guard before update or delete on fixed_asset_disposals
  for each row execute function tohyee_guard_fixed_asset_disposal();
create trigger fixed_asset_disposals_no_truncate before truncate on fixed_asset_disposals
  for each statement execute function tohyee_guard_fixed_asset_disposal();

-- A bill can't be voided while an asset is registered from one of its lines
-- (FA2): the register would keep a cost the ledger no longer has.
create function tohyee_check_bill_fixed_assets() returns trigger
language plpgsql as $$
declare
  asset text;
begin
  if new.status = 'voided' and old.status <> 'voided' then
    select a.asset_number into asset from fixed_assets a join bill_lines l on l.id = a.bill_line_id
     where l.bill_id = new.id and a.status <> 'archived' order by a.asset_number limit 1;
    if asset is not null then
      raise exception 'Bill #% is registered as fixed asset %, so it can''t be voided. Archive the asset first', new.id, asset
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger bills_fixed_assets before update on bills
  for each row execute function tohyee_check_bill_fixed_assets();
`,
  };
