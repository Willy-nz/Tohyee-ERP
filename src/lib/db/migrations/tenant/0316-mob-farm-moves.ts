import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
  version: "0316",
  name: "mob_farm_moves",
  sql: `
-- Moving stock to another farm in the same organisation (OPF7-OPF13): a
-- move, not a sale. The mob it leaves gets "farm_out" and the mob it joins,
-- on the other farm, gets "farm_in", each naming the other mob, so the
-- withholding and the history follow the animals. No livestock movement.
alter table mob_events drop constraint mob_events_event_type_check;
alter table mob_events add constraint mob_events_event_type_check check (event_type in (
  'created', 'moved', 'split_out', 'split_in', 'merged_out', 'merged_in',
  'sold', 'died', 'born', 'bought', 'reclass', 'weighed', 'counted', 'closed',
  'animals_out', 'animals_in', 'reversed', 'farm_out', 'farm_in'));
alter table mob_events add constraint mob_events_farm_move_other check (event_type not in ('farm_out', 'farm_in') or other_mob_id is not null);
`,
};
