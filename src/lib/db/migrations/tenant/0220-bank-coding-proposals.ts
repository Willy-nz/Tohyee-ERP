import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0220",
    name: "bank_coding_proposals",
    sql: `
-- Bank coding proposals (#544, decisions 1292-1299): coding for statement
-- lines (contact, account, GST, amount, why, how sure, what supports it)
-- kept for a person to review, without posting or reconciling anything.
-- Approving runs through a durable batch (kind bank_coding, #547), so each
-- approved row is posted exactly once and a stopped approval can be resumed.
alter table batches drop constraint batches_kind_check;
alter table batches add constraint batches_kind_check
  check (kind in ('bank_reconcile', 'bank_unreconcile', 'bank_undo', 'bank_coding'));

create table bank_coding_proposals (
  id bigserial primary key,
  account_id bigint not null references accounts(id),
  command_source text not null check (length(command_source) between 1 and 100),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  note text check (note is null or length(note) <= 500),
  -- Rows that weren't kept, with why: [{index, lineId, reason}].
  refused jsonb not null default '[]'::jsonb,
  created_by_user_id uuid,
  created_by_email text,
  -- e.g. 'AI key "Claude"' when an AI made it (decision 348).
  created_via text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create index bank_coding_proposals_account_idx on bank_coding_proposals (account_id, created_at desc, id desc);

-- One row per statement line. status is what a person decided: proposed,
-- rejected, or approved (then the approval's batch action says whether it's
-- waiting, posted or failed). The line as it was when proposed (seen_*) is
-- kept so a later change to the line shows the row as stale.
create table bank_coding_proposal_rows (
  id bigserial primary key,
  proposal_id bigint not null references bank_coding_proposals(id),
  position integer not null check (position >= 0),
  statement_line_id bigint not null references bank_statement_lines(id),
  seen_line_date date not null,
  seen_amount numeric not null,
  seen_reconciliations integer not null check (seen_reconciliations >= 0),
  contact_id bigint not null references contacts(id),
  account_code text not null check (length(account_code) between 1 and 20),
  tax_code text check (tax_code is null or length(tax_code) between 1 and 20),
  description text not null check (length(description) between 1 and 500),
  amount numeric not null check (amount > 0 and scale(amount) <= 2),
  rationale text check (rationale is null or length(rationale) <= 2000),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  gst_evidence text check (gst_evidence is null or gst_evidence in ('tax_document', 'person_said', 'contact_usual', 'no_gst_supply')),
  evidence text check (evidence is null or length(evidence) <= 2000),
  -- The coding as first proposed, kept after a person edits it.
  original jsonb not null,
  status text not null default 'proposed' check (status in ('proposed', 'rejected', 'approved')),
  version integer not null default 1 check (version >= 1),
  edited_by_email text,
  edited_at timestamptz,
  reviewed_by_user_id uuid,
  reviewed_by_email text,
  reviewed_at timestamptz,
  reject_reason text check (reject_reason is null or length(reject_reason) <= 500),
  approval_action_id bigint references batch_actions(id),
  posted_reconciliation_id bigint references bank_reconciliations(id),
  unique (proposal_id, position),
  check ((status = 'approved') = (approval_action_id is not null))
);
create index bank_coding_proposal_rows_line_idx on bank_coding_proposal_rows (statement_line_id);

create function tohyee_forbid_proposal_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'bank coding proposals can''t be deleted' using errcode = 'P0001';
end;
$$;
create trigger bank_coding_proposals_no_delete before delete on bank_coding_proposals
  for each row execute function tohyee_forbid_proposal_delete();
create trigger bank_coding_proposal_rows_no_delete before delete on bank_coding_proposal_rows
  for each row execute function tohyee_forbid_proposal_delete();
`,
  };
