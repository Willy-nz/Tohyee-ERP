import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0024",
    name: "member_access_window",
    sql: `
-- Time-limited access (decisions 1466-1474): an owner or admin can say when
-- a member's access starts and ends, for example a bookkeeper hired for a
-- month. Outside these times every request, key and AI connection the member
-- uses is refused. Both are instants (the dates and times people enter are
-- in the server's business time zone). access_ends_at is the first moment
-- they can't get in: "until 12 Dec" ends at midnight at the start of 13 Dec.
-- Null means no limit. Nothing is deleted when access ends.
alter table organisation_members add column access_starts_at timestamptz;
alter table organisation_members add column access_ends_at timestamptz;
alter table organisation_members add constraint organisation_members_access_order
  check (access_starts_at is null or access_ends_at is null or access_starts_at < access_ends_at);
create index organisation_members_access_ends_idx on organisation_members (access_ends_at) where access_ends_at is not null;
`,
  };
