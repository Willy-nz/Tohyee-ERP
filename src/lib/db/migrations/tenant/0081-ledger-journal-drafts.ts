import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0081",
    name: "ledger_journal_drafts",
    sql: `
-- Draft manual journals (decisions 349-352; examples MJD1-MJD9, like Xero's
-- draft manual journals). A draft posts nothing. Posting it posts one manual
-- journal through the usual path (balanced, open period, account rules) and
-- links it here; a posted draft can't change or be deleted. Drafts can be
-- deleted by people (not by AI keys, which never delete).
create table ledger_journal_drafts (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'posted')),
  posting_date date not null,
  reference text not null check (length(reference) between 1 and 100),
  description text,
  custom_fields jsonb not null default '{}'::jsonb,
  total numeric not null check (total > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  -- e.g. 'AI key "Claude on my laptop"' when an AI key made it; null for a person.
  created_via text,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_via text,
  updated_at timestamptz not null default now(),
  posted_journal_id bigint unique references ledger_journals(id),
  posted_by_email text,
  posted_via text,
  posted_at timestamptz,
  unique (command_source, idempotency_key),
  check ((status = 'posted') = (posted_journal_id is not null))
);
create index ledger_journal_drafts_status_idx on ledger_journal_drafts (status, id desc);

create table ledger_journal_draft_lines (
  draft_id bigint not null references ledger_journal_drafts(id) on delete cascade,
  line_order integer not null check (line_order > 0),
  account_id bigint not null references accounts(id),
  description text,
  debit_amount numeric not null default 0 check (debit_amount >= 0),
  credit_amount numeric not null default 0 check (credit_amount >= 0),
  tracking jsonb not null default '{}'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  foreign_amount numeric,
  exchange_rate numeric,
  primary key (draft_id, line_order),
  check ((debit_amount > 0) <> (credit_amount > 0)),
  check ((foreign_amount is null) = (exchange_rate is null))
);

-- A posted draft is history: it can't change (other than nothing) or be deleted.
create function tohyee_guard_journal_draft() returns trigger
language plpgsql as $$
begin
  if old.status = 'posted' then
    raise exception 'This draft journal has been posted, so it can''t be changed or deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger ledger_journal_drafts_guard before update or delete on ledger_journal_drafts
  for each row execute function tohyee_guard_journal_draft();

create function tohyee_guard_journal_draft_line() returns trigger
language plpgsql as $$
begin
  if (select status from ledger_journal_drafts where id = coalesce(new.draft_id, old.draft_id)) = 'posted' then
    raise exception 'This draft journal has been posted, so its lines can''t change' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger ledger_journal_draft_lines_guard before insert or update or delete on ledger_journal_draft_lines
  for each row execute function tohyee_guard_journal_draft_line();
`,
  };
