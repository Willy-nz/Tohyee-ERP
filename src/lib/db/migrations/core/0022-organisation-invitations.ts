import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0022",
    name: "organisation_invitations",
    sql: `
-- Inviting people from People and roles (#441, decisions 870-879). A row
-- here means the membership came with a login this invitation made. It shows
-- as "Invited" until that login is first signed in to; Cancel can then take
-- the login away too, if nothing else uses it. It goes with the membership.
create table organisation_invitations (
  organisation_id text not null,
  user_id uuid not null,
  invited_by_user_id uuid references users(id) on delete set null,
  invited_by_email text not null check (length(invited_by_email) <= 320),
  invited_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  primary key (organisation_id, user_id),
  foreign key (organisation_id, user_id) references organisation_members (organisation_id, user_id) on delete cascade
);
create index organisation_invitations_user_id_idx on organisation_invitations (user_id);
`,
  };
