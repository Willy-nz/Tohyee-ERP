import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0100",
    name: "approval_workflows",
    sql: `
-- Approval workflows (AW1-AW17, decisions 424-431): rules that send a bill,
-- purchase order or expense claim through approval steps before it's
-- approved. Rules are archived, never deleted; their steps are replaced when
-- a rule is edited, and a waiting request follows the rule as it is now.
create table approval_rules (
  id bigserial primary key,
  document_type text not null check (document_type in ('bill', 'purchase_order', 'expense_claim')),
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  position integer not null check (position > 0),
  -- Conditions, all of which must hold; null means any.
  min_total numeric check (min_total is null or min_total >= 0),
  contact_id bigint references contacts(id),
  claimant_user_id uuid,
  claimant_email text check (claimant_email is null or length(claimant_email) between 1 and 320),
  account_id bigint references accounts(id),
  tracking_value_id bigint references tracking_values(id),
  version integer not null default 1 check (version > 0),
  archived_at timestamptz,
  archived_by_email text,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  check ((archived_at is null) = (archived_by_email is null)),
  check ((claimant_user_id is null) = (claimant_email is null)),
  check (document_type = 'expense_claim' or claimant_user_id is null),
  check (document_type <> 'expense_claim' or contact_id is null)
);
create unique index approval_rules_name_key on approval_rules (document_type, lower(name)) where archived_at is null;

create table approval_rule_steps (
  id bigserial primary key,
  rule_id bigint not null references approval_rules(id),
  step_number integer not null check (step_number between 1 and 10),
  mode text not null check (mode in ('any', 'all')),
  unique (rule_id, step_number)
);

create table approval_step_approvers (
  step_id bigint not null references approval_rule_steps(id) on delete cascade,
  user_id uuid not null,
  email text not null check (length(email) between 1 and 320),
  primary key (step_id, user_id)
);

-- A document's trip through a rule's steps. One waiting request per document.
create table approval_requests (
  id bigserial primary key,
  document_type text not null check (document_type in ('bill', 'purchase_order', 'expense_claim')),
  document_id bigint not null,
  rule_id bigint not null references approval_rules(id),
  rule_name text not null,
  status text not null default 'waiting' check (status in ('waiting', 'approved', 'declined', 'withdrawn')),
  submitted_by_user_id uuid,
  submitted_by_email text not null,
  submitted_at timestamptz not null default now(),
  finished_by_email text,
  finished_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) between 1 and 500),
  -- Why the final approval was refused (a locked period, AW10); cleared when it goes through.
  last_error text check (last_error is null or length(last_error) <= 1000),
  last_error_at timestamptz,
  check ((status = 'waiting') = (finished_at is null)),
  check ((status = 'declined') = (decline_reason is not null))
);
create unique index approval_requests_one_waiting on approval_requests (document_type, document_id) where status = 'waiting';
create index approval_requests_document on approval_requests (document_type, document_id, id);

-- Each approval or decline of a step, by one person.
create table approval_actions (
  id bigserial primary key,
  request_id bigint not null references approval_requests(id),
  step_number integer not null check (step_number between 1 and 10),
  action text not null check (action in ('approved', 'declined')),
  user_id uuid,
  email text not null,
  reason text check (reason is null or length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (request_id, step_number, email)
);

-- Requests and their actions are the record of who approved what.
create function tohyee_guard_approval_history() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'Approval history is kept; it can''t be deleted' using errcode = 'P0001';
  end if;
  if tg_table_name = 'approval_actions' then
    raise exception 'An approval action never changes' using errcode = 'P0001';
  end if;
  if old.status <> 'waiting' then
    raise exception 'A finished approval request never changes' using errcode = 'P0001';
  end if;
  if new.document_type <> old.document_type or new.document_id <> old.document_id or new.rule_id <> old.rule_id then
    raise exception 'An approval request''s document and rule never change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger approval_requests_guard before update or delete on approval_requests
  for each row execute function tohyee_guard_approval_history();
create trigger approval_requests_no_truncate before truncate on approval_requests
  for each statement execute function tohyee_guard_approval_history();
create trigger approval_actions_guard before update or delete on approval_actions
  for each row execute function tohyee_guard_approval_history();
create trigger approval_actions_no_truncate before truncate on approval_actions
  for each statement execute function tohyee_guard_approval_history();

-- The email to each approver of a step (AW3, AW12), sent through the
-- organisation's email by the email job.
create table approval_emails (
  id bigserial primary key,
  request_id bigint not null references approval_requests(id),
  step_number integer not null,
  to_user_id uuid not null,
  to_email text not null check (length(to_email) between 1 and 320),
  subject text not null check (length(subject) between 1 and 250),
  body text not null check (length(body) between 1 and 5000),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (request_id, step_number, to_user_id)
);
create index approval_emails_due on approval_emails (next_attempt_at) where status in ('queued', 'sending');

-- A repeating bill whose bill a rule matches is submitted instead (AW14).
alter table repeating_bill_runs drop constraint repeating_bill_runs_outcome_check;
alter table repeating_bill_runs add constraint repeating_bill_runs_outcome_check check (outcome in ('draft', 'approved', 'approval_refused', 'submitted'));
alter table repeating_bill_runs add constraint repeating_bill_runs_submitted_message check (outcome <> 'submitted' or message is not null);
`,
  };
