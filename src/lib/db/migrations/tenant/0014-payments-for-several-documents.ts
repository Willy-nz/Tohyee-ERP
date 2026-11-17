import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0014",
    name: "payments_for_several_documents",
    sql: `
-- One amount received from a customer (or paid to a supplier) for several of
-- their invoices (bills), examples MP1-MP10 and SMP1-SMP6. It posts one
-- journal with one line on the bank account for the whole amount. Each
-- invoice's (bill's) part is an ordinary customer (supplier) payment with
-- batch_id set, sharing that journal, so amounts due, overpayments and the
-- GST return work as before. The batch is voided as a whole, with one
-- reversal journal shared the same way.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch'));

create table customer_payment_batches (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  contact_id bigint not null references contacts(id),
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
create index customer_payment_batches_contact_idx on customer_payment_batches (contact_id, payment_date desc, id desc);

create table supplier_payment_batches (like customer_payment_batches including defaults including constraints);
alter table supplier_payment_batches
  add primary key (id),
  add unique (journal_id),
  add unique (void_journal_id),
  add unique (command_source, idempotency_key),
  add unique (void_command_source, void_idempotency_key),
  add foreign key (contact_id) references contacts(id),
  add foreign key (bank_account_id) references accounts(id),
  add foreign key (journal_id) references ledger_journals(id),
  add foreign key (void_journal_id) references ledger_journals(id);
create sequence supplier_payment_batches_id_seq owned by supplier_payment_batches.id;
alter table supplier_payment_batches alter column id set default nextval('supplier_payment_batches_id_seq');
create index supplier_payment_batches_contact_idx on supplier_payment_batches (contact_id, payment_date desc, id desc);

-- A payment's journal is its own, unless it's part of a batch, whose parts share the batch's journals.
alter table customer_payments
  add column batch_id bigint references customer_payment_batches(id),
  drop constraint customer_payments_journal_id_key,
  drop constraint customer_payments_void_journal_id_key;
create unique index customer_payments_journal_idx on customer_payments (journal_id) where batch_id is null;
create unique index customer_payments_void_journal_idx on customer_payments (void_journal_id) where batch_id is null;
create index customer_payments_batch_idx on customer_payments (batch_id) where batch_id is not null;
alter table supplier_payments
  add column batch_id bigint references supplier_payment_batches(id),
  drop constraint supplier_payments_journal_id_key,
  drop constraint supplier_payments_void_journal_id_key;
create unique index supplier_payments_journal_idx on supplier_payments (journal_id) where batch_id is null;
create unique index supplier_payments_void_journal_idx on supplier_payments (void_journal_id) where batch_id is null;
create index supplier_payments_batch_idx on supplier_payments (batch_id) where batch_id is not null;

-- A batch is recorded as active and only ever voided once (void details only).
create function tohyee_guard_payment_batch() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated', tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Payments can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'active' then
      raise exception 'A payment is recorded as active and voided afterwards' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Payments can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;
create trigger customer_payment_batches_guard
  before insert or update or delete on customer_payment_batches
  for each row execute function tohyee_guard_payment_batch();
create trigger customer_payment_batches_no_truncate
  before truncate on customer_payment_batches
  for each statement execute function tohyee_guard_payment_batch();
create trigger supplier_payment_batches_guard
  before insert or update or delete on supplier_payment_batches
  for each row execute function tohyee_guard_payment_batch();
create trigger supplier_payment_batches_no_truncate
  before truncate on supplier_payment_batches
  for each statement execute function tohyee_guard_payment_batch();

-- At the end of the transaction a batch's parts are all there and agree with
-- it: the same customer (supplier), date, bank account, currency, journals and
-- status, adding up to the amount received (paid), each invoice (bill) once.
create function tohyee_check_payment_batch_parts() returns trigger
language plpgsql as $$
declare
  batch record;
  parts record;
begin
  if tg_table_name = 'customer_payment_batches' then
    select * into batch from customer_payment_batches where id = new.id;
    select count(*) as n, count(distinct p.invoice_id) as documents, coalesce(sum(p.amount), 0) as total,
           bool_and(i.contact_id = batch.contact_id and p.payment_date = batch.payment_date
                    and p.bank_account_id = batch.bank_account_id and p.currency_code = batch.currency_code
                    and p.journal_id = batch.journal_id and p.status = batch.status
                    and p.void_journal_id is not distinct from batch.void_journal_id) as agree
      into parts
      from customer_payments p join sales_invoices i on i.id = p.invoice_id
     where p.batch_id = new.id;
  else
    select * into batch from supplier_payment_batches where id = new.id;
    select count(*) as n, count(distinct p.bill_id) as documents, coalesce(sum(p.amount), 0) as total,
           bool_and(b.contact_id = batch.contact_id and p.payment_date = batch.payment_date
                    and p.bank_account_id = batch.bank_account_id and p.currency_code = batch.currency_code
                    and p.journal_id = batch.journal_id and p.status = batch.status
                    and p.void_journal_id is not distinct from batch.void_journal_id) as agree
      into parts
      from supplier_payments p join bills b on b.id = p.bill_id
     where p.batch_id = new.id;
  end if;
  if parts.n = 0 or parts.documents <> parts.n or parts.total <> batch.amount or not parts.agree then
    raise exception 'A payment for several documents must be made of one part for each, adding up to the amount paid'
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;
create constraint trigger customer_payment_batches_parts
  after insert or update on customer_payment_batches
  deferrable initially deferred
  for each row execute function tohyee_check_payment_batch_parts();
create constraint trigger supplier_payment_batches_parts
  after insert or update on supplier_payment_batches
  deferrable initially deferred
  for each row execute function tohyee_check_payment_batch_parts();

-- One part of a batch can't be voided on its own: the batch is voided first,
-- in the same transaction, then its parts (examples MP5 and SMP4).
create function tohyee_guard_payment_batch_part() returns trigger
language plpgsql as $$
declare
  batch_status text;
begin
  if tg_op = 'UPDATE' and old.batch_id is not null and old.status = 'active' and new.status = 'voided' then
    if tg_table_name = 'customer_payments' then
      select status into batch_status from customer_payment_batches where id = old.batch_id;
    else
      select status into batch_status from supplier_payment_batches where id = old.batch_id;
    end if;
    if batch_status <> 'voided' then
      raise exception 'This is part of a payment for several documents: void the whole payment' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.batch_id is distinct from old.batch_id then
    raise exception 'Payments can''t be changed, only voided once' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger customer_payments_batch_guard
  before update on customer_payments
  for each row execute function tohyee_guard_payment_batch_part();
create trigger supplier_payments_batch_guard
  before update on supplier_payments
  for each row execute function tohyee_guard_payment_batch_part();
`,
  };
