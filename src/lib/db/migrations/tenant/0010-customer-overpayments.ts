import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0010",
    name: "customer_overpayments",
    sql: `
-- Journals posted by refunding an overpayment or voiding that refund.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund'));

-- The part of a payment that was more than its invoice's amount due when it
-- was recorded (examples OP1-OP4). The rest of the payment pays the invoice.
-- It's fixed when the payment is recorded; earlier payments were never more
-- than the amount due, so theirs is 0. The whole payment still posts one
-- journal, Dr the bank account / Cr accounts receivable, so the overpayment
-- sits in accounts receivable as credit for the customer.
alter table customer_payments
  add column overpayment_amount numeric not null default 0
    check (overpayment_amount >= 0 and overpayment_amount <= amount);

-- Overpayment credit applied to another approved invoice of the same
-- customer and currency. Like credit note applications, applying posts no
-- journal (both sides are accounts receivable), one command can cover
-- several invoices, and removing one, once, fills in its removal details.
create table customer_overpayment_applications (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  payment_id bigint not null references customer_payments(id),
  invoice_id bigint not null references sales_invoices(id),
  application_date date not null,
  amount numeric not null check (amount > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  removal_date date,
  removal_command_source text,
  removal_idempotency_key text,
  removal_request_hash text,
  removed_by_user_id uuid,
  removed_by_email text,
  removed_at timestamptz,
  unique (command_source, idempotency_key, invoice_id),
  unique (removal_command_source, removal_idempotency_key),
  check (removal_date is null or removal_date >= application_date),
  check (
    (status = 'active'
      and removal_date is null and removal_command_source is null and removal_idempotency_key is null
      and removal_request_hash is null and removed_at is null)
    or (status = 'removed'
      and removal_date is not null and removal_command_source is not null and removal_idempotency_key is not null
      and removal_request_hash is not null and removed_at is not null)
  )
);
create index customer_overpayment_applications_payment_idx on customer_overpayment_applications (payment_id, id);
create index customer_overpayment_applications_invoice_idx on customer_overpayment_applications (invoice_id, id);

-- Remaining overpayment paid back to the customer. Recording a refund posts
-- Dr accounts receivable / Cr the bank account; voiding it posts the exact
-- reversal.
create table customer_overpayment_refunds (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  payment_id bigint not null references customer_payments(id),
  refund_date date not null,
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
  check (void_date is null or void_date >= refund_date),
  check (
    (status = 'active'
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index customer_overpayment_refunds_payment_idx on customer_overpayment_refunds (payment_id, id);
create index customer_overpayment_refunds_bank_account_idx on customer_overpayment_refunds (bank_account_id);

-- What's been settled on an invoice: the invoice part of its active payments
-- (the payment less its overpayment), its active credit note credit and its
-- active overpayment credit.
create function tohyee_invoice_settled(invoice bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(amount - overpayment_amount) from customer_payments
                    where invoice_id = invoice and status = 'active'), 0)
       + coalesce((select sum(amount) from sales_credit_note_applications
                    where invoice_id = invoice and status = 'active'), 0)
       + coalesce((select sum(amount) from customer_overpayment_applications
                    where invoice_id = invoice and status = 'active'), 0)
$$;

-- What's been used of a payment's overpayment: its active applications and
-- active refunds.
create function tohyee_overpayment_used(payment bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(amount) from customer_overpayment_applications
                    where payment_id = payment and status = 'active'), 0)
       + coalesce((select sum(amount) from customer_overpayment_refunds
                    where payment_id = payment and status = 'active'), 0)
$$;

-- A payment is recorded as active, against an approved invoice, in the
-- invoice's currency and dated on or after it. Its overpayment must be
-- exactly what it pays beyond the invoice's amount due at that moment (all of
-- it if the invoice is already paid), so what's settled on an invoice never goes over its total. The
-- invoice stays locked until the transaction ends, so two payments can't both
-- take what's left.
create or replace function toeyee_check_customer_payment() returns trigger
language plpgsql as $$
declare
  invoice record;
  due numeric;
begin
  if new.status <> 'active' then
    raise exception 'A payment is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select status, invoice_number, invoice_date, currency_code, total into invoice
    from sales_invoices where id = new.invoice_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  if invoice.status <> 'approved' then
    raise exception 'Payments can only be recorded against approved invoices' using errcode = 'P0001';
  end if;
  if new.currency_code <> invoice.currency_code then
    raise exception 'A payment must be in its invoice''s currency' using errcode = 'P0001';
  end if;
  if new.payment_date < invoice.invoice_date then
    raise exception 'A payment can''t be dated before its invoice' using errcode = 'P0001';
  end if;
  due := invoice.total - tohyee_invoice_settled(new.invoice_id);
  if new.overpayment_amount <> greatest(new.amount - due, 0) then
    raise exception 'The overpayment on a payment against invoice % must be what it pays beyond the amount due (%)',
      invoice.invoice_number, due using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Payments can't be edited or deleted. Voiding one, once, only fills in its
-- void details, and not while any of its overpayment is applied or refunded.
create or replace function toeyee_guard_customer_payment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'customer_payments can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Customer payments can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    if tohyee_overpayment_used(old.id) > 0 then
      raise exception 'This payment''s overpayment has been applied or refunded, so it can''t be voided. Remove its applications and refunds first'
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Customer payments can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

-- Credit note applications also count overpayment credit applied to the
-- invoice (replaces the 0007 check; otherwise the same).
create or replace function tohyee_check_credit_note_application() returns trigger
language plpgsql as $$
declare
  credit_note record;
  invoice record;
  used numeric;
begin
  if new.status <> 'active' then
    raise exception 'An application is recorded as active and removed afterwards' using errcode = 'P0001';
  end if;
  select status, credit_note_number, contact_id, credit_note_date, currency_code, total into credit_note
    from sales_credit_notes where id = new.credit_note_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  select status, invoice_number, contact_id, invoice_date, currency_code, total into invoice
    from sales_invoices where id = new.invoice_id for update;
  if not found then
    return new;
  end if;
  if credit_note.status <> 'approved' then
    raise exception 'Only approved credit notes can be applied' using errcode = 'P0001';
  end if;
  if invoice.status <> 'approved' then
    raise exception 'Credit can only be applied to approved invoices' using errcode = 'P0001';
  end if;
  if invoice.contact_id <> credit_note.contact_id then
    raise exception 'Credit can only be applied to invoices of the same customer' using errcode = 'P0001';
  end if;
  if new.currency_code <> credit_note.currency_code or new.currency_code <> invoice.currency_code then
    raise exception 'Credit can only be applied in the credit note''s and invoice''s currency' using errcode = 'P0001';
  end if;
  if new.application_date < credit_note.credit_note_date or new.application_date < invoice.invoice_date then
    raise exception 'An application can''t be dated before its credit note or invoice' using errcode = 'P0001';
  end if;
  if tohyee_invoice_settled(new.invoice_id) + new.amount > invoice.total then
    raise exception 'Payments and credit applied to invoice % can''t add up to more than its total', invoice.invoice_number
      using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from sales_credit_note_applications
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
       + coalesce((select sum(amount) from sales_credit_note_refunds
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
    into used;
  if used + new.amount > credit_note.total then
    raise exception 'Credit applied and refunded from credit note % can''t add up to more than its total',
      credit_note.credit_note_number using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- An overpayment application is recorded as active, from an active payment
-- with an overpayment to another approved invoice of the same customer and
-- currency, dated on or after both the payment and the invoice. The invoice's
-- settled amount can't go over its total, and the overpayment's applications
-- and refunds can't add up to more than the overpayment. The payment and
-- then the invoice stay locked until the transaction ends.
create function tohyee_check_overpayment_application() returns trigger
language plpgsql as $$
declare
  payment record;
  invoice record;
begin
  if new.status <> 'active' then
    raise exception 'An application is recorded as active and removed afterwards' using errcode = 'P0001';
  end if;
  select p.status, p.invoice_id, p.payment_date, p.currency_code, p.overpayment_amount, i.contact_id into payment
    from customer_payments p join sales_invoices i on i.id = p.invoice_id
   where p.id = new.payment_id for update of p;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  select status, invoice_number, contact_id, invoice_date, currency_code, total into invoice
    from sales_invoices where id = new.invoice_id for update;
  if not found then
    return new;
  end if;
  if payment.status <> 'active' then
    raise exception 'Overpayments can only be applied from active payments' using errcode = 'P0001';
  end if;
  if new.invoice_id = payment.invoice_id then
    raise exception 'An overpayment can''t be applied to the invoice it overpaid' using errcode = 'P0001';
  end if;
  if invoice.status <> 'approved' then
    raise exception 'Credit can only be applied to approved invoices' using errcode = 'P0001';
  end if;
  if invoice.contact_id <> payment.contact_id then
    raise exception 'Credit can only be applied to invoices of the same customer' using errcode = 'P0001';
  end if;
  if new.currency_code <> payment.currency_code or new.currency_code <> invoice.currency_code then
    raise exception 'Credit can only be applied in the payment''s and invoice''s currency' using errcode = 'P0001';
  end if;
  if new.application_date < payment.payment_date or new.application_date < invoice.invoice_date then
    raise exception 'An application can''t be dated before its payment or invoice' using errcode = 'P0001';
  end if;
  if tohyee_invoice_settled(new.invoice_id) + new.amount > invoice.total then
    raise exception 'Payments and credit applied to invoice % can''t add up to more than its total', invoice.invoice_number
      using errcode = 'P0001';
  end if;
  if tohyee_overpayment_used(new.payment_id) + new.amount > payment.overpayment_amount then
    raise exception 'Overpayment applied and refunded can''t add up to more than the overpayment' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Overpayment applications can't be edited or deleted. Removing one, once,
-- only fills in its removal details.
create function tohyee_guard_overpayment_application() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'customer_overpayment_applications can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Overpayment applications can''t be deleted; remove them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'removed'
     and (to_jsonb(new) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at'])
       = (to_jsonb(old) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at']) then
    return new;
  end if;
  raise exception 'Overpayment applications can''t be changed, only removed once' using errcode = 'P0001';
end;
$$;

-- An overpayment refund is recorded as active, from an active payment, in its
-- currency and dated on or after it, and the overpayment's applications and
-- refunds can't add up to more than the overpayment.
create function tohyee_check_overpayment_refund() returns trigger
language plpgsql as $$
declare
  payment record;
begin
  if new.status <> 'active' then
    raise exception 'A refund is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select status, payment_date, currency_code, overpayment_amount into payment
    from customer_payments where id = new.payment_id for update;
  if not found then
    return new;
  end if;
  if payment.status <> 'active' then
    raise exception 'Overpayments can only be refunded from active payments' using errcode = 'P0001';
  end if;
  if new.currency_code <> payment.currency_code then
    raise exception 'A refund must be in its payment''s currency' using errcode = 'P0001';
  end if;
  if new.refund_date < payment.payment_date then
    raise exception 'A refund can''t be dated before its payment' using errcode = 'P0001';
  end if;
  if tohyee_overpayment_used(new.payment_id) + new.amount > payment.overpayment_amount then
    raise exception 'Overpayment applied and refunded can''t add up to more than the overpayment' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Overpayment refunds can't be edited or deleted. Voiding one, once, only
-- fills in its void details.
create function tohyee_guard_overpayment_refund() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'customer_overpayment_refunds can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Overpayment refunds can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Overpayment refunds can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

-- An invoice with active overpayment credit applied can't be voided; its
-- credit is removed first.
create function tohyee_guard_overpaid_credit_invoice_void() returns trigger
language plpgsql as $$
begin
  if old.status <> 'voided' and new.status = 'voided'
     and exists (select 1 from customer_overpayment_applications where invoice_id = new.id and status = 'active') then
    raise exception 'Invoice % has credit applied to it, so it can''t be voided. Remove its credit first',
      old.invoice_number using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger customer_overpayment_applications_check
  before insert on customer_overpayment_applications
  for each row execute function tohyee_check_overpayment_application();
create trigger customer_overpayment_applications_guard
  before update or delete on customer_overpayment_applications
  for each row execute function tohyee_guard_overpayment_application();
create trigger customer_overpayment_applications_no_truncate
  before truncate on customer_overpayment_applications
  for each statement execute function tohyee_guard_overpayment_application();
create trigger customer_overpayment_refunds_check
  before insert on customer_overpayment_refunds
  for each row execute function tohyee_check_overpayment_refund();
create trigger customer_overpayment_refunds_guard
  before update or delete on customer_overpayment_refunds
  for each row execute function tohyee_guard_overpayment_refund();
create trigger customer_overpayment_refunds_no_truncate
  before truncate on customer_overpayment_refunds
  for each statement execute function tohyee_guard_overpayment_refund();
create trigger sales_invoices_overpayment_credit_guard
  before update on sales_invoices
  for each row execute function tohyee_guard_overpaid_credit_invoice_void();
`,
  };
