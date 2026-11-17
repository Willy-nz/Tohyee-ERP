import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0063",
    name: "payroll_bank_files_and_payslips",
    sql: `
-- Payroll stage P5 (examples PBF1-PBF7, PSLIP1-PSLIP6).

-- Bank direct credit files (PBF7): each bank account's own account number
-- and the bank's file format, chosen by an admin. Not secret (it's on every
-- invoice), so not encrypted. Westpac and Kiwibank aren't offered: neither
-- publishes a field-level specification.
alter table bank_account_settings
  add column direct_credit_format text
    check (direct_credit_format in ('anz_domestic_extended', 'asb_mt9', 'bnz_ib4b')),
  add column direct_credit_account_number text
    check (direct_credit_account_number is null or direct_credit_account_number ~ '^[0-9]{2}-[0-9]{4}-[0-9]{7}-[0-9]{2,3}$'),
  add column direct_credit_updated_by_email text,
  add column direct_credit_updated_at timestamptz,
  add constraint bank_account_settings_direct_credit_check
    check ((direct_credit_format is null) = (direct_credit_account_number is null));

-- Payslip emails (PSLIP5) go through the document email outbox. A payslip
-- is one employee on one approved pay run; it has no contact and no bigint
-- document id. The message never holds pay figures (it's fixed text), and
-- the PDF is written when the email is sent.
alter table document_emails
  alter column document_id drop not null,
  alter column contact_id drop not null,
  add column pay_run_id uuid references payroll_pay_runs(id),
  add column employee_id uuid references payroll_employees(id);
alter table document_emails drop constraint document_emails_document_kind_check;
alter table document_emails add constraint document_emails_document_kind_check
  check (document_kind in ('invoice', 'credit_note', 'quote', 'purchase_order', 'statement', 'payslip'));
alter table document_emails add constraint document_emails_payslip_check
  check (case when document_kind = 'payslip'
              then pay_run_id is not null and employee_id is not null and document_id is null
                   and contact_id is null and batch_id is null
              else pay_run_id is null and employee_id is null and document_id is not null and contact_id is not null end);
create index document_emails_payslip on document_emails (pay_run_id, employee_id, id) where pay_run_id is not null;

create or replace function tohyee_guard_document_email() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'Emails are kept as a record of what was sent; they can''t be deleted' using errcode = 'P0001';
  end if;
  if old.status in ('sent', 'failed') then
    raise exception 'Email % has finished and can''t be changed; send it again instead', old.id using errcode = 'P0001';
  end if;
  if new.document_kind is distinct from old.document_kind or new.document_id is distinct from old.document_id
     or new.contact_id is distinct from old.contact_id or new.statement is distinct from old.statement
     or new.pay_run_id is distinct from old.pay_run_id or new.employee_id is distinct from old.employee_id
     or new.batch_id is distinct from old.batch_id or new.to_addresses is distinct from old.to_addresses
     or new.cc_addresses is distinct from old.cc_addresses or new.subject is distinct from old.subject
     or new.body is distinct from old.body or new.attachment_name is distinct from old.attachment_name
     or new.requested_by_email is distinct from old.requested_by_email
     or new.requested_by_user_id is distinct from old.requested_by_user_id or new.created_at is distinct from old.created_at
     or new.request_hash is distinct from old.request_hash or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'What an email says and who it goes to can''t change once it''s queued' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
`,
  };
