import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0006",
    name: "supplier_payments",
    sql: `
-- Journals posted by recording or voiding a supplier payment.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment'));

-- Money paid against one approved bill. Recording it posts Dr accounts
-- payable / Cr the bank account; voiding it posts the exact reversal. A
-- bill's amount due is its total less its active payments, worked out
-- whenever it's read and never stored.
create table supplier_payments (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  bill_id bigint not null references bills(id),
  payment_date date not null,
  amount numeric not null check (amount > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  bank_account_id bigint not null references accounts(id),
  reference text check (reference is null or length(reference) between 1 and 100),
  journal_id bigint not null unique references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  unique (command_source, idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (void_date is null or void_date >= payment_date),
  check (
    (status = 'active'
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index supplier_payments_bill_idx on supplier_payments (bill_id, id);
create index supplier_payments_bank_account_idx on supplier_payments (bank_account_id);

-- A payment is recorded as active, against an approved bill, in the bill's
-- currency and dated on or after it, and a bill's active payments can't add
-- up to more than its total (no overpayments yet). The bill stays locked
-- until the transaction ends, so two payments can't both take what's left.
create function tohyee_check_supplier_payment() returns trigger
language plpgsql as $$
declare
  bill record;
  paid numeric;
begin
  if new.status <> 'active' then
    raise exception 'A payment is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select id, status, bill_date, currency_code, total into bill
    from bills where id = new.bill_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  if bill.status <> 'approved' then
    raise exception 'Payments can only be recorded against approved bills' using errcode = 'P0001';
  end if;
  if new.currency_code <> bill.currency_code then
    raise exception 'A payment must be in its bill''s currency' using errcode = 'P0001';
  end if;
  if new.payment_date < bill.bill_date then
    raise exception 'A payment can''t be dated before its bill' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount), 0) into paid
    from supplier_payments where bill_id = new.bill_id and status = 'active';
  if paid + new.amount > bill.total then
    raise exception 'Payments against bill #% can''t add up to more than its total', bill.id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Payments can't be edited or deleted. Voiding one, once, only fills in its
-- void details.
create function tohyee_guard_supplier_payment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'supplier_payments can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Supplier payments can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Supplier payments can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

-- A bill with active payments can't be voided; its payments are voided first.
create function tohyee_guard_paid_bill_void() returns trigger
language plpgsql as $$
begin
  if old.status <> 'voided' and new.status = 'voided'
     and exists (select 1 from supplier_payments where bill_id = new.id and status = 'active') then
    raise exception 'Bill #% has payments against it, so it can''t be voided. Void its payments first',
      old.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger supplier_payments_check
  before insert on supplier_payments
  for each row execute function tohyee_check_supplier_payment();
create trigger supplier_payments_guard
  before update or delete on supplier_payments
  for each row execute function tohyee_guard_supplier_payment();
create trigger supplier_payments_no_truncate
  before truncate on supplier_payments
  for each statement execute function tohyee_guard_supplier_payment();
create trigger bills_payments_guard
  before update on bills
  for each row execute function tohyee_guard_paid_bill_void();
`,
  };
