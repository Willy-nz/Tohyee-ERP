import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0218",
    name: "batches",
    sql: `
-- Durable batches (#547, decisions 1273-1279): a list of actions asked for
-- in one go (an AI's bulk_reconcile, a person's "Unreconcile selected", the
-- undo of a batch), kept so what happened to each action can be read after
-- a lost answer or a server restart, and the rest resumed with the same
-- idempotency keys. Generic on purpose: other kinds of batch can be added
-- to the kind check later.
create table batches (
  id bigserial primary key,
  kind text not null check (kind in ('bank_reconcile', 'bank_unreconcile', 'bank_undo')),
  command_source text not null check (length(command_source) between 1 and 100),
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null,
  -- The batch this one undoes (kind bank_undo).
  undoes_batch_id bigint references batches(id),
  created_by_user_id uuid,
  created_by_email text,
  -- e.g. 'AI key "Claude"' when an AI asked for it (decision 348).
  created_via text,
  created_at timestamptz not null default now(),
  -- How many times work on it has started, and when last.
  runs integer not null default 0 check (runs >= 0),
  last_run_at timestamptz,
  -- Who is working on it now: a lease that runs out by itself, so a server
  -- that stopped mid-batch never blocks it for long.
  lease_token text,
  lease_until timestamptz,
  -- Not before this time (a rate limit said to wait).
  not_before timestamptz,
  unique (command_source, idempotency_key),
  check ((kind = 'bank_undo') = (undoes_batch_id is not null))
);
create index batches_created_idx on batches (created_at desc, id desc);
create index batches_undoes_idx on batches (undoes_batch_id) where undoes_batch_id is not null;

-- One row per action, in the order asked. What was asked (action, target,
-- payload, idempotency key) never changes; only its progress does.
--   pending    not started (or put back after a rate limit)
--   started    work began and no outcome was recorded: the outcome is
--              unknown until a resume checks it with the same key
--   committed  done; its effect and this status committed together
--   failed     refused, with the reason; its effect was rolled back
create table batch_actions (
  id bigserial primary key,
  batch_id bigint not null references batches(id),
  position integer not null check (position >= 0),
  action text not null check (length(action) between 1 and 50),
  target_id text check (target_id is null or length(target_id) <= 50),
  payload jsonb not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 300),
  status text not null default 'pending' check (status in ('pending', 'started', 'committed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  result jsonb,
  error text check (error is null or length(error) <= 2000),
  started_at timestamptz,
  finished_at timestamptz,
  unique (batch_id, position)
);
create index batch_actions_target_idx on batch_actions (target_id) where target_id is not null;

create function tohyee_guard_batch_action() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'batch actions can''t be deleted' using errcode = 'P0001';
  end if;
  if new.batch_id <> old.batch_id or new.position <> old.position or new.action <> old.action
     or new.target_id is distinct from old.target_id or new.payload <> old.payload
     or new.idempotency_key <> old.idempotency_key then
    raise exception 'what a batch action asked for can''t be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger batch_actions_guard before update or delete on batch_actions
  for each row execute function tohyee_guard_batch_action();
create function tohyee_forbid_batch_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'batches can''t be deleted' using errcode = 'P0001';
end;
$$;
create trigger batches_no_delete before delete on batches
  for each row execute function tohyee_forbid_batch_delete();
`,
  };
