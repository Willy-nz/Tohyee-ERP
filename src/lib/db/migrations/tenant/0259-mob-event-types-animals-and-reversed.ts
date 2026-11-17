import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0259",
    name: "mob_event_types_animals_and_reversed",
    sql: `
-- 0237 (tagged animals moving between mobs) and 0252 (reversing a head
-- count change) each rewrote this check with only their own new types, so
-- whichever ran last dropped the other's. Allow all of them.
alter table mob_events drop constraint mob_events_event_type_check;
alter table mob_events add constraint mob_events_event_type_check check (event_type in (
  'created', 'moved', 'split_out', 'split_in', 'merged_out', 'merged_in',
  'sold', 'died', 'born', 'bought', 'reclass', 'weighed', 'counted', 'closed',
  'animals_out', 'animals_in', 'reversed'));
`,
  };
