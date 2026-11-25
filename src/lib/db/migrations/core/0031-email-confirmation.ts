import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0031",
    name: "email_confirmation",
    sql: `
-- Whether a login's email address is known to belong to the person using it.
-- A login set up through a link that was handed over by hand (the invitation
-- couldn't be emailed) isn't, until a link that reached that mailbox is used,
-- or Google sign-in with the same address. Until then another organisation
-- can't add it: the invitation waits instead.
alter table users add column email_confirmed_at timestamptz default now();
-- Logins made by an organisation's invitation may have been set up through a
-- copied link; we can't tell now, so they confirm next time it matters.
update users u set email_confirmed_at = null
 where not u.is_server_admin
   and exists (select 1 from organisation_invitations i where i.user_id = u.id);

-- A setup link proves the email address when it was only ever emailed, or a
-- server admin made it.
alter table user_setup_links add column proves_email boolean not null default false;

-- Invitations waiting for a login's email address to be confirmed.
create table organisation_waiting_members (
  organisation_id text not null references organisations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'bookkeeper', 'viewer', 'report_viewer', 'sales_manager', 'sales_rep', 'farm_worker')),
  access_starts_at timestamptz,
  access_ends_at timestamptz,
  invited_by_user_id uuid references users(id) on delete set null,
  invited_by_email text not null check (length(invited_by_email) <= 320),
  invited_at timestamptz not null default now(),
  primary key (organisation_id, user_id)
);
create index organisation_waiting_members_user_id_idx on organisation_waiting_members (user_id);
`,
  };
