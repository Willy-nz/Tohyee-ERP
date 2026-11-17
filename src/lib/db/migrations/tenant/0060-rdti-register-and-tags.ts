import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0060",
    name: "rdti_register_and_tags",
    sql: `
-- R&D Tax Incentive, stage R2 (docs/ACCOUNTING-EXAMPLES.md RD1-RD3, RD8-RD13,
-- RD21-RD23; docs/DECISIONS.md 30-50): the activity register, approvals with
-- IRD's letter, files kept with history, tags linking posted cost lines to
-- activities, fixed asset tax depreciation and usage logs, and a history of
-- every change. Nothing here posts or changes an amount. Who and when come
-- from the signed-in user and the server's clock: the stamp triggers below
-- overwrite whatever a statement supplies, so nothing is backdated.

create function tohyee_rd_stamp_created() returns trigger
language plpgsql as $$
begin
  new.created_at := now();
  return new;
end;
$$;

create function tohyee_rd_stamp_changed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.updated_by_user_id := new.created_by_user_id;
    new.updated_by_email := new.created_by_email;
  else
    new.created_at := old.created_at;
    new.created_by_user_id := old.created_by_user_id;
    new.created_by_email := old.created_by_email;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create function tohyee_rd_forbid() returns trigger
language plpgsql as $$
begin
  raise exception '% are kept: they can''t be %', tg_argv[0],
    case tg_op when 'UPDATE' then 'changed' else 'deleted' end
    using errcode = 'P0001';
end;
$$;

-- The register (RD1, RD2). Archived, never deleted.
create table rd_activities (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  name text not null check (length(name) between 1 and 200 and name = btrim(name)),
  project_name text not null check (length(project_name) between 1 and 200 and project_name = btrim(project_name)),
  kind text not null check (kind in ('core', 'supporting')),
  place text not null check (place in ('nz', 'overseas')),
  first_income_year integer not null check (first_income_year between 2000 and 2999),
  last_income_year integer check (last_income_year is null or last_income_year between first_income_year and 2999),
  purpose_and_uncertainty text not null default '' check (length(purpose_and_uncertainty) <= 10000),
  why_not_public_knowledge text not null default '' check (length(why_not_public_knowledge) <= 10000),
  systematic_approach text not null default '' check (length(systematic_approach) <= 10000),
  why_required text not null default '' check (length(why_required) <= 10000),
  status text not null default 'active' check (status in ('active', 'archived')),
  archived_at timestamptz,
  archived_by_user_id uuid,
  archived_by_email text,
  version integer not null default 1 check (version > 0),
  material_changed_at timestamptz,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  -- Core R&D must be performed in New Zealand (LY 2(1)(c); IR1240 p 12).
  check (kind = 'supporting' or place = 'nz'),
  check (kind = 'supporting' or why_required = ''),
  check ((status = 'archived') = (archived_at is not null)),
  check ((archived_at is null) = (archived_by_email is null))
);
create unique index rd_activities_code_idx on rd_activities (lower(code));

-- The core activities a supporting activity supports (decision 39: one
-- supporting activity can support several). Changing them is a change to
-- the activity, kept in rd_history.
create table rd_activity_supports (
  supporting_id uuid not null references rd_activities(id),
  core_id uuid not null references rd_activities(id),
  primary key (supporting_id, core_id),
  check (supporting_id <> core_id)
);
create index rd_activity_supports_core_idx on rd_activity_supports (core_id);

create function tohyee_assert_rd_activity(target uuid) returns void
language plpgsql as $$
declare
  activity record;
begin
  select id, code, kind into activity from rd_activities where id = target;
  if not found then
    return;
  end if;
  if activity.kind = 'core' then
    if exists (select 1 from rd_activity_supports where supporting_id = target) then
      raise exception 'R&D activity % is core, so it doesn''t support another activity', activity.code using errcode = '23514';
    end if;
  else
    if not exists (select 1 from rd_activity_supports where supporting_id = target) then
      raise exception 'Supporting R&D activity % needs the core activity it supports', activity.code using errcode = '23514';
    end if;
    if exists (select 1 from rd_activity_supports where core_id = target) then
      raise exception 'R&D activity % is supporting, so another activity can''t support it', activity.code using errcode = '23514';
    end if;
    if exists (select 1 from rd_activity_supports s join rd_activities c on c.id = s.core_id
                where s.supporting_id = target and c.kind <> 'core') then
      raise exception 'Supporting R&D activity % can only support core activities', activity.code using errcode = '23514';
    end if;
  end if;
end;
$$;
create function tohyee_check_rd_activity() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'rd_activities' then
    perform tohyee_assert_rd_activity(new.id);
  elsif tg_op = 'DELETE' then
    perform tohyee_assert_rd_activity(old.supporting_id);
    perform tohyee_assert_rd_activity(old.core_id);
  else
    perform tohyee_assert_rd_activity(new.supporting_id);
    perform tohyee_assert_rd_activity(new.core_id);
  end if;
  return null;
end;
$$;
create constraint trigger rd_activities_links
  after insert or update on rd_activities
  deferrable initially deferred
  for each row execute function tohyee_check_rd_activity();
create constraint trigger rd_activity_supports_links
  after insert or delete on rd_activity_supports
  deferrable initially deferred
  for each row execute function tohyee_check_rd_activity();

create trigger rd_activities_stamp before insert or update on rd_activities
  for each row execute function tohyee_rd_stamp_changed();
create trigger rd_activities_no_delete before delete on rd_activities
  for each row execute function tohyee_rd_forbid('R&D activities');
create trigger rd_activities_no_truncate before truncate on rd_activities
  for each statement execute function tohyee_rd_forbid('R&D activities');
create trigger rd_activity_supports_no_change before update on rd_activity_supports
  for each row execute function tohyee_rd_forbid('R&D activity links');
create trigger rd_activity_supports_no_truncate before truncate on rd_activity_supports
  for each statement execute function tohyee_rd_forbid('R&D activity links');

-- Files on R&D records (decision 45): kept, never deleted. Replacing one
-- adds a new row pointing at the one it replaces, so the old file stays.
create table rd_files (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  record_type text not null check (record_type in ('activity', 'approval', 'tag', 'asset')),
  record_id text not null check (length(record_id) between 1 and 60),
  purpose text not null check (purpose in ('approval_letter', 'contractor_statement', 'workings', 'other')),
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null check (content_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea not null check (octet_length(content) = byte_size),
  replaces_id uuid unique references rd_files(id),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check (replaces_id is null or replaces_id <> id)
);
create index rd_files_record_idx on rd_files (record_type, record_id);
create trigger rd_files_stamp before insert on rd_files
  for each row execute function tohyee_rd_stamp_created();
create trigger rd_files_append_only before update or delete on rd_files
  for each row execute function tohyee_rd_forbid('R&D files');
create trigger rd_files_no_truncate before truncate on rd_files
  for each statement execute function tohyee_rd_forbid('R&D files');

-- Approvals as entered from IRD's letter (RD3; decision 40). Only general
-- approval (TAA 68CB) for now; it covers up to 3 income years. The letter is
-- required: an approval can't be saved without one.
create table rd_approvals (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  kind text not null check (kind in ('general')),
  reference text not null check (length(reference) between 1 and 100 and reference = btrim(reference)),
  letter_date date not null,
  first_income_year integer not null check (first_income_year between 2000 and 2999),
  last_income_year integer not null check (last_income_year between first_income_year and first_income_year + 2),
  note text check (note is null or length(note) <= 2000),
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  withdrawn_reason text check (withdrawn_reason is null or length(withdrawn_reason) between 1 and 500),
  withdrawn_at timestamptz,
  withdrawn_by_user_id uuid,
  withdrawn_by_email text,
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  check ((status = 'withdrawn') = (withdrawn_at is not null)),
  check ((withdrawn_at is null) = (withdrawn_reason is null)),
  check ((withdrawn_at is null) = (withdrawn_by_email is null))
);
create table rd_approval_activities (
  approval_id uuid not null references rd_approvals(id),
  activity_id uuid not null references rd_activities(id),
  primary key (approval_id, activity_id)
);
create index rd_approval_activities_activity_idx on rd_approval_activities (activity_id);

create function tohyee_assert_rd_approval(target uuid) returns void
language plpgsql as $$
begin
  if not exists (select 1 from rd_approvals where id = target) then
    return;
  end if;
  if not exists (select 1 from rd_approval_activities where approval_id = target) then
    raise exception 'An R&D approval needs the activities it covers' using errcode = '23514';
  end if;
  if not exists (select 1 from rd_files where record_type = 'approval' and record_id = target::text and purpose = 'approval_letter') then
    raise exception 'An R&D approval needs IRD''s letter attached' using errcode = '23514';
  end if;
end;
$$;
create function tohyee_check_rd_approval() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'rd_approvals' then
    perform tohyee_assert_rd_approval(new.id);
  else
    perform tohyee_assert_rd_approval(new.approval_id);
  end if;
  return null;
end;
$$;
create constraint trigger rd_approvals_complete
  after insert on rd_approvals
  deferrable initially deferred
  for each row execute function tohyee_check_rd_approval();
create constraint trigger rd_approval_activities_complete
  after insert on rd_approval_activities
  deferrable initially deferred
  for each row execute function tohyee_check_rd_approval();

-- Only withdrawing changes an approval; what was entered from the letter stays.
create function tohyee_guard_rd_approval() returns trigger
language plpgsql as $$
begin
  if old.status <> 'active' or new.status <> 'withdrawn'
     or (new.kind, new.reference, new.letter_date, new.first_income_year, new.last_income_year, new.note)
        is distinct from (old.kind, old.reference, old.letter_date, old.first_income_year, old.last_income_year, old.note) then
    raise exception 'R&D approvals are kept as entered; an approval can only be withdrawn' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger rd_approvals_guard before update on rd_approvals
  for each row execute function tohyee_guard_rd_approval();
create trigger rd_approvals_stamp before insert or update on rd_approvals
  for each row execute function tohyee_rd_stamp_changed();
create trigger rd_approvals_no_delete before delete on rd_approvals
  for each row execute function tohyee_rd_forbid('R&D approvals');
create trigger rd_approvals_no_truncate before truncate on rd_approvals
  for each statement execute function tohyee_rd_forbid('R&D approvals');
create trigger rd_approval_activities_append_only before update or delete on rd_approval_activities
  for each row execute function tohyee_rd_forbid('R&D approvals');
create trigger rd_approval_activities_no_truncate before truncate on rd_approval_activities
  for each statement execute function tohyee_rd_forbid('R&D approvals');

-- A tag links one posted cost line to an activity (RD8, RD9, RD11-RD13). The
-- line's amount is excluding GST and in the base currency at the document's
-- rate; amount is the R&D share, rounded down to the cent. Tags are removed,
-- never deleted, and only one active tag can be on a line.
create table rd_tags (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  source_type text not null
    check (source_type in ('bill_line', 'expense_claim_receipt', 'bank_transaction_line', 'journal_line')),
  -- Checked by tohyee_check_rd_tag_source rather than foreign keys, so the
  -- source tables keep refusing TRUNCATE with their own messages.
  bill_line_id bigint,
  expense_claim_receipt_id bigint,
  bank_transaction_line_id bigint,
  journal_line_id bigint,
  activity_id uuid not null references rd_activities(id),
  work_date date not null,
  line_amount numeric not null check (line_amount > 0),
  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  amount numeric not null check (amount >= 0 and amount <= line_amount),
  eligibility text not null check (eligibility in ('eligible', 'ineligible')),
  category text check (category in ('employee', 'materials_overheads', 'contract', 'approved_research_provider')),
  ineligible_reason text check (length(ineligible_reason) between 1 and 60),
  overseas boolean not null default false,
  commercial_production boolean not null default false,
  internal_software boolean not null default false,
  feedstock boolean not null default false,
  contractor_ineligible_amount numeric not null default 0 check (contractor_ineligible_amount >= 0),
  unused_amount numeric not null default 0 check (unused_amount >= 0),
  unused_marked_by_user_id uuid,
  unused_marked_by_email text,
  unused_marked_at timestamptz,
  note text check (note is null or length(note) <= 2000),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_reason text check (removed_reason is null or length(removed_reason) between 1 and 500),
  removed_at timestamptz,
  removed_by_user_id uuid,
  removed_by_email text,
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  check (num_nonnulls(bill_line_id, expense_claim_receipt_id, bank_transaction_line_id, journal_line_id) = 1),
  check ((source_type = 'bill_line') = (bill_line_id is not null)),
  check ((source_type = 'expense_claim_receipt') = (expense_claim_receipt_id is not null)),
  check ((source_type = 'bank_transaction_line') = (bank_transaction_line_id is not null)),
  check ((source_type = 'journal_line') = (journal_line_id is not null)),
  check ((eligibility = 'eligible') = (category is not null)),
  check ((eligibility = 'ineligible') = (ineligible_reason is not null)),
  check (contractor_ineligible_amount = 0 or category in ('contract', 'approved_research_provider')),
  check (eligibility = 'eligible' or (unused_amount = 0 and contractor_ineligible_amount = 0)),
  check (unused_amount + contractor_ineligible_amount <= amount),
  check ((unused_amount = 0) = (unused_marked_at is null)),
  check ((unused_marked_at is null) = (unused_marked_by_email is null)),
  check ((status = 'removed') = (removed_at is not null)),
  check ((removed_at is null) = (removed_reason is null)),
  check ((removed_at is null) = (removed_by_email is null))
);
create unique index rd_tags_bill_line_idx on rd_tags (bill_line_id) where status = 'active' and bill_line_id is not null;
create unique index rd_tags_claim_receipt_idx on rd_tags (expense_claim_receipt_id)
  where status = 'active' and expense_claim_receipt_id is not null;
create unique index rd_tags_bank_line_idx on rd_tags (bank_transaction_line_id)
  where status = 'active' and bank_transaction_line_id is not null;
create unique index rd_tags_journal_line_idx on rd_tags (journal_line_id) where status = 'active' and journal_line_id is not null;
create index rd_tags_activity_idx on rd_tags (activity_id, work_date);
create index rd_tags_work_date_idx on rd_tags (work_date);

-- The line a tag is on, its date and amount never change, and a removed tag
-- stays removed.
create function tohyee_guard_rd_tag() returns trigger
language plpgsql as $$
begin
  if old.status = 'removed'
     or (new.source_type, new.bill_line_id, new.expense_claim_receipt_id, new.bank_transaction_line_id, new.journal_line_id,
         new.work_date, new.line_amount)
        is distinct from (old.source_type, old.bill_line_id, old.expense_claim_receipt_id, old.bank_transaction_line_id,
                          old.journal_line_id, old.work_date, old.line_amount) then
    raise exception 'An R&D tag stays on its line; remove it and tag the line again instead' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create function tohyee_check_rd_tag_source() returns trigger
language plpgsql as $$
declare
  line_exists boolean;
begin
  line_exists := case new.source_type
    when 'bill_line' then exists (select 1 from bill_lines where id = new.bill_line_id)
    when 'expense_claim_receipt' then exists (select 1 from expense_claim_receipts where id = new.expense_claim_receipt_id)
    when 'bank_transaction_line' then exists (select 1 from bank_transaction_lines where id = new.bank_transaction_line_id)
    else exists (select 1 from ledger_journal_lines where id = new.journal_line_id)
  end;
  if not line_exists then
    raise exception 'An R&D tag must be on an existing line' using errcode = '23503';
  end if;
  return new;
end;
$$;
create trigger rd_tags_source before insert on rd_tags
  for each row execute function tohyee_check_rd_tag_source();
create trigger rd_tags_guard before update on rd_tags
  for each row execute function tohyee_guard_rd_tag();
create trigger rd_tags_stamp before insert or update on rd_tags
  for each row execute function tohyee_rd_stamp_changed();
create trigger rd_tags_no_delete before delete on rd_tags
  for each row execute function tohyee_rd_forbid('R&D tags');
create trigger rd_tags_no_truncate before truncate on rd_tags
  for each statement execute function tohyee_rd_forbid('R&D tags');

-- Tax depreciation entered per asset for an income year (RD11; decision 33),
-- never the book depreciation the fixed asset register posts. Investment
-- Boost (DI 5) counts as depreciation. The latest entry for an asset and year
-- counts; earlier ones are its history.
create table rd_asset_tax_depreciation (
  id uuid primary key default gen_random_uuid(),
  entry_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  -- Checked by tohyee_check_rd_asset, like rd_tags' lines.
  asset_id bigint not null,
  income_year integer not null check (income_year between 2000 and 2999),
  tax_depreciation numeric not null check (tax_depreciation >= 0),
  investment_boost numeric not null check (investment_boost >= 0),
  ineligible_reason text check (length(ineligible_reason) between 1 and 60),
  note text check (note is null or length(note) <= 2000),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index rd_asset_tax_depreciation_asset_idx on rd_asset_tax_depreciation (asset_id, income_year, entry_number);
create function tohyee_check_rd_asset() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from fixed_assets where id = new.asset_id) then
    raise exception 'That fixed asset doesn''t exist' using errcode = '23503';
  end if;
  return new;
end;
$$;
create trigger rd_asset_tax_depreciation_asset before insert on rd_asset_tax_depreciation
  for each row execute function tohyee_check_rd_asset();
create trigger rd_asset_tax_depreciation_stamp before insert on rd_asset_tax_depreciation
  for each row execute function tohyee_rd_stamp_created();
create trigger rd_asset_tax_depreciation_append_only before update or delete on rd_asset_tax_depreciation
  for each row execute function tohyee_rd_forbid('R&D tax depreciation entries');
create trigger rd_asset_tax_depreciation_no_truncate before truncate on rd_asset_tax_depreciation
  for each statement execute function tohyee_rd_forbid('R&D tax depreciation entries');

-- An asset's usage log (RD11): hours on an activity, or on other work when
-- activity_id is null. Idle time isn't logged.
create table rd_asset_usage (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  asset_id bigint not null,
  activity_id uuid references rd_activities(id),
  work_date date not null,
  hours numeric(9,2) not null check (hours > 0 and hours <= 100000),
  description text check (description is null or length(description) <= 500),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_reason text check (removed_reason is null or length(removed_reason) between 1 and 500),
  removed_at timestamptz,
  removed_by_user_id uuid,
  removed_by_email text,
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  check ((status = 'removed') = (removed_at is not null)),
  check ((removed_at is null) = (removed_reason is null)),
  check ((removed_at is null) = (removed_by_email is null))
);
create index rd_asset_usage_asset_idx on rd_asset_usage (asset_id, work_date);
create function tohyee_guard_rd_asset_usage() returns trigger
language plpgsql as $$
begin
  if old.status = 'removed' or (new.asset_id, new.work_date) is distinct from (old.asset_id, old.work_date) then
    raise exception 'A usage log entry keeps its asset and date; remove it and enter a new one instead' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger rd_asset_usage_asset before insert on rd_asset_usage
  for each row execute function tohyee_check_rd_asset();
create trigger rd_asset_usage_guard before update on rd_asset_usage
  for each row execute function tohyee_guard_rd_asset_usage();
create trigger rd_asset_usage_stamp before insert or update on rd_asset_usage
  for each row execute function tohyee_rd_stamp_changed();
create trigger rd_asset_usage_no_delete before delete on rd_asset_usage
  for each row execute function tohyee_rd_forbid('Usage log entries');
create trigger rd_asset_usage_no_truncate before truncate on rd_asset_usage
  for each statement execute function tohyee_rd_forbid('Usage log entries');

-- Every version of every R&D record: what it was, who saved it and when
-- (RD23). Append-only.
create table rd_history (
  id bigserial primary key,
  record_type text not null
    check (record_type in ('activity', 'approval', 'tag', 'asset_usage', 'asset_tax_depreciation', 'file')),
  record_id text not null check (length(record_id) between 1 and 60),
  version integer not null check (version > 0),
  action text not null check (action in ('created', 'changed', 'archived', 'restored', 'withdrawn', 'removed', 'replaced')),
  snapshot jsonb not null,
  changed_by_user_id uuid,
  changed_by_email text not null,
  created_at timestamptz not null default now(),
  unique (record_type, record_id, version)
);
create trigger rd_history_stamp before insert on rd_history
  for each row execute function tohyee_rd_stamp_created();
create trigger rd_history_append_only before update or delete on rd_history
  for each row execute function tohyee_rd_forbid('R&D history');
create trigger rd_history_no_truncate before truncate on rd_history
  for each statement execute function tohyee_rd_forbid('R&D history');

-- Payroll's hook (P1b): an allocation line's R&D activity is now a real
-- reference to the register. Pay runs don't tag R&D yet (P3).
alter table payroll_cost_allocation_lines
  add constraint payroll_cost_allocation_lines_rd_activity_fkey foreign key (rd_activity_id) references rd_activities(id);
create index payroll_cost_allocation_lines_rd_activity_idx on payroll_cost_allocation_lines (rd_activity_id)
  where rd_activity_id is not null;
`,
  };
