import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0032",
    name: "bank_reconciliation_splits",
    sql: `
-- One posted journal line shown by the bank as several statement lines (a
-- payment the bank split in two, say): example BK26. A split ties the lines
-- together; each line still gets its own reconciliation (kind 'split') with
-- one item for its part of the journal line. The parts add up to the journal
-- line exactly, and the lines are reconciled and unreconciled together.
create table bank_reconciliation_splits (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  account_id bigint not null references accounts(id),
  journal_line_id bigint not null references ledger_journal_lines(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);

create function tohyee_guard_reconciliation_split() returns trigger
language plpgsql as $$
begin
  raise exception 'Split reconciliations can''t be changed or deleted; unreconcile instead' using errcode = 'P0001';
end;
$$;
create trigger bank_reconciliation_splits_guard
  before update or delete on bank_reconciliation_splits
  for each row execute function tohyee_guard_reconciliation_split();
create trigger bank_reconciliation_splits_no_truncate
  before truncate on bank_reconciliation_splits
  for each statement execute function tohyee_guard_reconciliation_split();

alter table bank_reconciliations add column split_id bigint references bank_reconciliation_splits(id);
alter table bank_reconciliations drop constraint bank_reconciliations_kind_check;
alter table bank_reconciliations add constraint bank_reconciliations_kind_check
  check (kind in ('match', 'payments', 'bank_transaction', 'transfer', 'split'));
alter table bank_reconciliations add constraint bank_reconciliations_split_check
  check ((kind = 'split') = (split_id is not null));
create index bank_reconciliations_split_idx on bank_reconciliations (split_id) where split_id is not null;

alter table bank_reconciliation_items add column split_id bigint references bank_reconciliation_splits(id);
-- A journal line is in at most one active reconciliation, unless it's split,
-- when all its active items belong to the one split (checked at commit).
drop index bank_reconciliation_items_active_journal_line_key;
create unique index bank_reconciliation_items_active_journal_line_key
  on bank_reconciliation_items (journal_line_id) where active and split_id is null;
create index bank_reconciliation_items_journal_line_idx on bank_reconciliation_items (journal_line_id) where active;

-- As before, plus: a split's reconciliations are all active or all removed,
-- there are at least two, each has one item for part of the split's journal
-- line (same sign, smaller), and the active parts add up to it exactly with
-- nothing else reconciled against it.
create or replace function tohyee_check_reconciliation(target bigint) returns void
language plpgsql as $$
declare
  rec record;
  line record;
  split record;
  total numeric;
  wrong integer;
begin
  select * into rec from bank_reconciliations where id = target;
  if not found then
    return;
  end if;
  select * into line from bank_statement_lines where id = rec.statement_line_id;
  if rec.status = 'active' then
    if line.status <> 'reconciled' then
      raise exception 'Statement line % has a reconciliation but isn''t marked reconciled', line.id using errcode = '23514';
    end if;
    select coalesce(sum(i.amount), 0),
           count(*) filter (
             where j.account_id <> line.account_id
                or i.split_id is distinct from rec.split_id
                or (i.split_id is null and i.amount <> j.debit_amount - j.credit_amount)
                or (i.split_id is null and exists (
                      select 1 from bank_reconciliation_items o
                       where o.active and o.journal_line_id = i.journal_line_id and o.id <> i.id))
                or (i.split_id is not null and (sign(i.amount) <> sign(j.debit_amount - j.credit_amount)
                      or abs(i.amount) >= abs(j.debit_amount - j.credit_amount))))
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
      select s.id, s.account_id, s.journal_line_id, j.debit_amount - j.credit_amount as journal_amount into split
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
`,
  };
