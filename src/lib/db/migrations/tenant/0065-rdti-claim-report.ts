import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0065",
    name: "rdti_claim_report",
    sql: `
-- R&D Tax Incentive, stage R3 (docs/ACCOUNTING-EXAMPLES.md RD10, RD23,
-- RD34, RD35, RD42; docs/DECISIONS.md 46, 58, 64): overhead rules ("% of an
-- account" to an activity, with a basis and the workings attached), applied
-- when the claim report runs; nothing here posts or changes an amount. The
-- claim report records each export's summary in rd_history.

alter table rd_history drop constraint rd_history_record_type_check;
alter table rd_history add constraint rd_history_record_type_check check (record_type in (
  'activity', 'approval', 'tag', 'asset_usage', 'asset_tax_depreciation', 'file', 'overhead_rule', 'claim_export'));
alter table rd_history drop constraint rd_history_action_check;
alter table rd_history add constraint rd_history_action_check check (action in (
  'created', 'changed', 'archived', 'restored', 'withdrawn', 'removed', 'replaced', 'ended', 'exported'));
alter table rd_files drop constraint rd_files_record_type_check;
alter table rd_files add constraint rd_files_record_type_check check (record_type in ('activity', 'approval', 'tag', 'asset', 'overhead_rule'));

-- An overhead rule (RD10, RD34): percentage of every posted line on an
-- expense account, dated in the rule's period, to one activity, with a basis
-- from IR1240 p 15's list and a description of the calculation. Changing a
-- rule adds a new one that replaces it (RD35): from the same start the old
-- one is marked replaced; from a later date the old one ends the day before.
-- Rules are never deleted.
create table rd_overhead_rules (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  account_id bigint not null references accounts(id),
  activity_id uuid not null references rd_activities(id),
  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  basis text not null check (basis in ('time', 'floor_area', 'usage', 'volume', 'unit_sales', 'dollar_value', 'activity_based_costing')),
  basis_detail text not null check (length(basis_detail) between 1 and 500 and basis_detail = btrim(basis_detail)),
  effective_from date not null,
  effective_to date check (effective_to is null or effective_to >= effective_from),
  replaces_id uuid unique references rd_overhead_rules(id),
  status text not null default 'active' check (status in ('active', 'replaced')),
  replaced_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  check ((status = 'replaced') = (replaced_at is not null)),
  check (replaces_id is null or replaces_id <> id)
);
create index rd_overhead_rules_account_idx on rd_overhead_rules (account_id, effective_from) where status = 'active';

-- What a rule applies to never changes; only its end date (ending it, or a
-- change from a later date) and being replaced. A replaced rule stays so.
create function tohyee_guard_rd_overhead_rule() returns trigger
language plpgsql as $$
begin
  if old.status = 'replaced'
     or (new.idempotency_key, new.request_hash, new.account_id, new.activity_id, new.percentage, new.basis, new.basis_detail,
         new.effective_from, new.replaces_id)
        is distinct from (old.idempotency_key, old.request_hash, old.account_id, old.activity_id, old.percentage, old.basis,
                          old.basis_detail, old.effective_from, old.replaces_id) then
    raise exception 'An overhead rule is kept as entered; change it by adding a rule that replaces it' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger rd_overhead_rules_guard before update on rd_overhead_rules
  for each row execute function tohyee_guard_rd_overhead_rule();
create trigger rd_overhead_rules_stamp before insert or update on rd_overhead_rules
  for each row execute function tohyee_rd_stamp_changed();
create trigger rd_overhead_rules_no_delete before delete on rd_overhead_rules
  for each row execute function tohyee_rd_forbid('Overhead rules');
create trigger rd_overhead_rules_no_truncate before truncate on rd_overhead_rules
  for each statement execute function tohyee_rd_forbid('Overhead rules');

-- The workings are required (decision 46): a rule can't be saved without them.
create function tohyee_check_rd_overhead_rule() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from rd_files where record_type = 'overhead_rule' and record_id = new.id::text and purpose = 'workings') then
    raise exception 'An overhead rule needs its workings attached' using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger rd_overhead_rules_workings
  after insert on rd_overhead_rules
  deferrable initially deferred
  for each row execute function tohyee_check_rd_overhead_rule();
`,
  };
