import type { Migration } from "@/lib/db/migrations/types";

export const migration: Migration = {
    version: "0252",
    name: "mob_event_reversals",
    sql: `
-- Reversing a mob's sale, death, birth, purchase or class change (#609,
-- decisions 1500-1505; MOB11-MOB13): a new "reversed" event that names
-- the one it reverses, so history is never edited and an event is
-- reversed once at most. Its livestock movement is voided in the same
-- transaction.
alter table mob_events drop constraint mob_events_event_type_check;
alter table mob_events add constraint mob_events_event_type_check check (event_type in (
  'created', 'moved', 'split_out', 'split_in', 'merged_out', 'merged_in',
  'sold', 'died', 'born', 'bought', 'reclass', 'weighed', 'counted', 'closed', 'reversed'));
alter table mob_events add column reverses_event_id bigint references mob_events(id);
alter table mob_events add constraint mob_events_reverses check ((event_type = 'reversed') = (reverses_event_id is not null));
create unique index mob_events_reverses_once on mob_events (reverses_event_id) where reverses_event_id is not null;
`,
  };
