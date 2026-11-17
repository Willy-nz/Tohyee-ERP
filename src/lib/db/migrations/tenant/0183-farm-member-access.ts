import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0183",
    name: "farm_member_access",
    sql: `
-- Which farms each member works on (#390, decision 744; Jess, 21 October
-- 2026: "Yes, assigned farms only"). With two or more farms, viewers and
-- bookkeepers see and record only for their farms; owners and admins see
-- every farm. A member with no row here has no farms yet. Members live in the
-- core database, so these rows name the user by id; they're removed when the
-- member leaves.
create table farm_member_scopes (
  user_id uuid primary key,
  all_farms boolean not null,
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
create table farm_member_farms (
  user_id uuid not null references farm_member_scopes(user_id) on delete cascade,
  farm_id bigint not null references farms(id),
  primary key (user_id, farm_id)
);
`,
  };
