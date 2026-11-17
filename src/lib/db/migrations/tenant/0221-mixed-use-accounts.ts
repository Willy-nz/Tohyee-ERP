import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0221",
    name: "mixed_use_accounts",
    sql: `
-- Personal and mixed-use bank and card accounts (#545, examples MU1-MU14,
-- decisions 1308-1315). An account is business only (no row, or 'business'),
-- mixed use or personal. A mixed-use or personal account's lines are never
-- reconciled: each is reviewed (business, private, split or refund). A
-- business part posts spend or receive money on the account and an owner
-- journal the other way, so the account's balance in the books stays 0.00
-- and the personal card's debt never becomes a business liability.
create table bank_account_usage (
  account_id bigint primary key references accounts(id),
  usage text not null check (usage in ('business', 'mixed', 'personal')),
  -- The equity account the owner's side goes to (3000 Owner funds introduced to start with).
  owner_account_id bigint references accounts(id),
  changed_by_email text,
  changed_at timestamptz not null default now(),
  check ((usage = 'business') = (owner_account_id is null))
);

-- One review per line at a time. What was decided never changes; undoing it
-- only fills in who undid it and when. automatic: private because the
-- account is personal (MU12), not because a person said so.
create table mixed_use_reviews (
  id bigserial primary key,
  command_source text,
  idempotency_key text,
  request_hash text,
  statement_line_id bigint not null references bank_statement_lines(id),
  decision text not null check (decision in ('business', 'private', 'split', 'refund')),
  business_amount numeric not null default 0 check (business_amount >= 0),
  private_amount numeric not null default 0 check (private_amount >= 0),
  refund_of_review_id bigint references mixed_use_reviews(id),
  bank_transaction_id bigint references bank_transactions(id),
  owner_journal_id bigint references ledger_journals(id),
  gst_evidence text check (gst_evidence is null or gst_evidence in ('tax_document', 'person_said', 'contact_usual', 'no_gst_supply')),
  not_duplicate boolean not null default false,
  automatic boolean not null default false,
  status text not null default 'active' check (status in ('active', 'undone')),
  created_by_user_id uuid,
  created_by_email text,
  created_via text,
  created_at timestamptz not null default now(),
  undo_command_source text,
  undo_idempotency_key text,
  undo_request_hash text,
  undone_by_user_id uuid,
  undone_by_email text,
  undone_via text,
  undone_at timestamptz,
  undo_reason text check (undo_reason is null or length(undo_reason) <= 200),
  owner_reversal_journal_id bigint references ledger_journals(id),
  unique (command_source, idempotency_key),
  unique (undo_command_source, undo_idempotency_key),
  check (automatic or (command_source is not null and idempotency_key is not null and request_hash is not null)),
  check (not automatic or decision = 'private'),
  check ((decision = 'refund') = (refund_of_review_id is not null)),
  check ((decision = 'private') = (bank_transaction_id is null and owner_journal_id is null)),
  check (decision <> 'private' or (business_amount = 0 and private_amount > 0)),
  check (decision <> 'business' or (business_amount > 0 and private_amount = 0)),
  check (decision <> 'split' or (business_amount > 0 and private_amount > 0)),
  check (decision <> 'refund' or business_amount > 0),
  check ((status = 'active') = (undone_at is null))
);
create unique index mixed_use_reviews_active_line on mixed_use_reviews (statement_line_id) where status = 'active';
create index mixed_use_reviews_refund_of on mixed_use_reviews (refund_of_review_id) where refund_of_review_id is not null;

create function tohyee_guard_mixed_use_review() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Reviews can''t be deleted; undo them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'undone'
     and (to_jsonb(new) - array['status', 'undo_command_source', 'undo_idempotency_key', 'undo_request_hash', 'undone_by_user_id',
            'undone_by_email', 'undone_via', 'undone_at', 'undo_reason', 'owner_reversal_journal_id'])
       = (to_jsonb(old) - array['status', 'undo_command_source', 'undo_idempotency_key', 'undo_request_hash', 'undone_by_user_id',
            'undone_by_email', 'undone_via', 'undone_at', 'undo_reason', 'owner_reversal_journal_id']) then
    return new;
  end if;
  if old.status = 'undone' and new.status = 'undone' and old.owner_reversal_journal_id is null
     and (to_jsonb(new) - 'owner_reversal_journal_id') = (to_jsonb(old) - 'owner_reversal_journal_id') then
    return new;
  end if;
  raise exception 'A review can''t be changed, only undone once' using errcode = 'P0001';
end;
$$;
create trigger mixed_use_reviews_guard before update or delete on mixed_use_reviews
  for each row execute function tohyee_guard_mixed_use_review();

-- The account's use, from its row (none: business only).
create function tohyee_account_usage(target bigint) returns text
language sql stable as $$
  select coalesce((select usage from bank_account_usage where account_id = target), 'business');
$$;

-- MU1: an account already in the business books can't become mixed use or personal.
create function tohyee_check_account_usage() returns trigger
language plpgsql as $$
declare
  balance numeric;
begin
  if new.usage = 'business' then
    return new;
  end if;
  select coalesce(sum(debit_amount - credit_amount), 0) into balance from ledger_journal_lines where account_id = new.account_id;
  if balance <> 0 or exists (select 1 from bank_statement_lines where account_id = new.account_id and status = 'reconciled') then
    raise exception 'This account is already in the business books (it has a balance or reconciled lines), so it can''t be mixed use or personal'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger bank_account_usage_check before insert or update on bank_account_usage
  for each row execute function tohyee_check_account_usage();

-- MU10: a mixed-use or personal account's balance in the books is always 0.00 (checked at commit).
create function tohyee_check_mixed_use_balance() returns trigger
language plpgsql as $$
declare
  balance numeric;
  label text;
begin
  if tohyee_account_usage(new.account_id) = 'business' then
    return null;
  end if;
  select coalesce(sum(debit_amount - credit_amount), 0) into balance from ledger_journal_lines where account_id = new.account_id;
  if balance <> 0 then
    select code || ' (' || name || ')' into label from accounts where id = new.account_id;
    raise exception 'Account % is a mixed-use or personal account, so nothing in the business books can be owed on it. Review its lines instead, and code payments to it from a business account to the owner''s drawings', label
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;
create constraint trigger ledger_journal_lines_mixed_use_balance
  after insert on ledger_journal_lines
  deferrable initially deferred
  for each row execute function tohyee_check_mixed_use_balance();

-- MU10: lines on a mixed-use or personal account are reviewed, never reconciled.
create function tohyee_forbid_mixed_use_reconciliation() returns trigger
language plpgsql as $$
begin
  if tohyee_account_usage((select account_id from bank_statement_lines where id = new.statement_line_id)) <> 'business' then
    raise exception 'This line is on a mixed-use or personal account, so it isn''t reconciled. Review it instead (business, private or split)'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger bank_reconciliations_mixed_use before insert on bank_reconciliations
  for each row execute function tohyee_forbid_mixed_use_reconciliation();

-- MU10: a reviewed line stays as reviewed until the review is undone. Its
-- import can be deleted only when it was reviewed as private.
create function tohyee_guard_reviewed_line() returns trigger
language plpgsql as $$
declare
  active_decision text;
begin
  if new.status = old.status then
    return new;
  end if;
  select decision into active_decision from mixed_use_reviews where statement_line_id = old.id and status = 'active';
  if active_decision is null or (active_decision = 'private' and new.status = 'deleted') then
    return new;
  end if;
  raise exception 'This line has been reviewed as %. Undo the review first', active_decision using errcode = 'P0001';
end;
$$;
create trigger bank_statement_lines_reviewed before update on bank_statement_lines
  for each row execute function tohyee_guard_reviewed_line();

-- MU12: a personal account's new lines are private straight away.
create function tohyee_personal_line_private() returns trigger
language plpgsql as $$
begin
  if new.status = 'unreconciled' and tohyee_account_usage(new.account_id) = 'personal' then
    update bank_statement_lines set status = 'excluded', updated_at = now() where id = new.id;
    insert into mixed_use_reviews (statement_line_id, decision, private_amount, automatic)
      values (new.id, 'private', abs(new.amount), true);
  end if;
  return null;
end;
$$;
create trigger bank_statement_lines_personal after insert on bank_statement_lines
  for each row execute function tohyee_personal_line_private();

-- Reviewing many lines in one go is a durable batch (#547).
alter table batches drop constraint batches_kind_check;
alter table batches add constraint batches_kind_check
  check (kind in ('bank_reconcile', 'bank_unreconcile', 'bank_undo', 'bank_coding', 'mixed_use_review'));
`,
  };
