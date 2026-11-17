import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0283",
    name: "ai_action_approvals",
    sql: `
-- A person approves the AI's voids, deletes and roll-backs (#697, decision
-- 1633; AIH1-AIH6). Off unless an owner turns it on.
create table ai_approval_settings (
  id boolean primary key default true check (id),
  required boolean not null default false,
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

-- One row per action the AI asked for while approval was on. The tool's
-- arguments are kept exactly as the AI sent them (with its idempotency key,
-- so approving twice can't do it twice) and the preview the AI was shown, so
-- the person approving sees the same thing. Nothing is deleted.
create table ai_action_requests (
  id bigserial primary key,
  tool_name text not null check (length(tool_name) between 1 and 100),
  title text not null check (length(title) between 1 and 200),
  arguments jsonb not null,
  preview jsonb not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  token_id text not null,
  source text not null,
  via text not null,
  requested_by_user_id uuid not null,
  requested_by_email text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'approved', 'declined', 'failed')),
  decided_by_email text,
  decided_at timestamptz,
  outcome jsonb,
  error text,
  created_at timestamptz not null default now(),
  check ((status in ('pending')) = (decided_at is null and decided_by_email is null))
);
create index ai_action_requests_status_idx on ai_action_requests (status, id desc);
create index ai_action_requests_hash_idx on ai_action_requests (request_hash, id desc);
`,
  };
