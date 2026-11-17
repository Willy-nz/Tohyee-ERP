import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0010",
    name: "organisation_handovers",
    sql: `
-- "Hand over this organisation" (#208, Jess 9 Oct 2026): a server admin
-- makes someone else an owner of an organisation whose owners can't (died,
-- left, won't answer). It takes effect after a 7-day wait, during which the
-- organisation's owners and admins are told and any of them can cancel it.
-- A server admin can't hand an organisation to themselves.
create table organisation_handovers (
  id bigserial primary key,
  organisation_id text not null references organisations(id) on delete cascade,
  to_user_id uuid not null references users(id) on delete cascade,
  reason text not null check (length(reason) between 5 and 500),
  requested_by_user_id uuid references users(id) on delete set null,
  requested_by_email text not null,
  status text not null default 'waiting' check (status in ('waiting', 'done', 'cancelled')),
  takes_effect_at timestamptz not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by_email text,
  completed_at timestamptz,
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((status = 'done') = (completed_at is not null)),
  check (to_user_id is distinct from requested_by_user_id)
);
create unique index organisation_handovers_one_waiting on organisation_handovers (organisation_id) where status = 'waiting';
`,
  };
