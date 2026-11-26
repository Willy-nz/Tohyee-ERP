import type { OrgTx } from "@/lib/db/org-transaction";
import { laterDate, meatSafeOn, milkSafeFrom, type Withholding } from "@/lib/farming/treatment-rules";
import { addDays } from "@/lib/farming/farm-words";

/*
 * Withholding worked out from what was recorded (TRT1-TRT4). Only queries: no checks of who's asking (callers have done
 * that for the farm).
 */

export type MobWithholding = Withholding & { treatmentIds: string[] };

/** Events that bring animals into a mob from another mob: a split, a merge, tags moved, or a move from another farm. */
const JOINS_IN = ["split_in", "merged_in", "animals_in", "farm_in"];

/**
 * Each mob's withholding: its own treatments, and those of mobs its
 * animals came from by a split or merge after the treatment (TRT3), so
 * stock split off a treated mob, or merged into another, carries the
 * withholding with it. Stock moved from another farm in the organisation
 * (OPF10) brings that farm's treatments too: the walk follows "farm_in"
 * to the mob it came from, on whichever farm.
 */
export async function mobWithholdings(tx: OrgTx, farmId: string): Promise<Map<string, MobWithholding>> {
  // Where each mob's animals came from: split from (the parent), merged in (the other mob), on a date.
  // Farms that stock came from are read too, and farms their stock came from (at most 20 rounds).
  const joins: Array<{ mob_id: string; farm_id: string; from_mob_id: string; on_date: string }> = [];
  const farms = new Set([farmId]);
  let pending = [farmId];
  for (let round = 0; pending.length && round < 20; round += 1) {
    const rows = await tx.query<{ mob_id: string; farm_id: string; from_mob_id: string; from_farm_id: string; on_date: string }>(
      `select e.mob_id::text, e.farm_id::text, e.other_mob_id::text as from_mob_id, o.farm_id::text as from_farm_id, e.event_date::text as on_date
         from mob_events e join mobs o on o.id = e.other_mob_id
        where e.farm_id = any($1::bigint[]) and e.event_type = any($2::text[])`,
      [pending, JOINS_IN],
    );
    joins.push(...rows.rows);
    pending = [...new Set(rows.rows.map((row) => row.from_farm_id).filter((id) => !farms.has(id)))];
    for (const id of pending) farms.add(id);
  }
  const treatments = await tx.query<{ id: string; farm_id: string; mob_id: string; treated_on: string; given_time: string | null; meat: number | null; milk: number | null }>(
    `select t.id::text, t.farm_id::text, t.mob_id::text, t.treated_on::text, to_char(t.given_time, 'HH24:MI') as given_time, t.meat_withholding_days as meat, t.milk_withholding_hours as milk
       from animal_treatments t where t.farm_id = any($1::bigint[]) and t.status = 'active' and t.mob_id is not null
        and (t.meat_withholding_days is not null or t.milk_withholding_hours is not null)`,
    [[...farms]],
  );
  const result = new Map<string, MobWithholding>();
  if (!treatments.rows.length) return result;
  const byMob = new Map<string, typeof treatments.rows>();
  for (const row of treatments.rows) byMob.set(row.mob_id, [...(byMob.get(row.mob_id) ?? []), row]);
  const add = (mobId: string, row: (typeof treatments.rows)[number]) => {
    const current = result.get(mobId) ?? { meatSafeOn: null, milkSafeFrom: null, treatmentIds: [] };
    if (current.treatmentIds.includes(row.id)) return;
    result.set(mobId, {
      meatSafeOn: laterDate(current.meatSafeOn, meatSafeOn(row.treated_on, row.meat)),
      milkSafeFrom: laterDate(current.milkSafeFrom, milkSafeFrom(row.treated_on, row.milk, row.given_time)),
      treatmentIds: [...current.treatmentIds, row.id],
    });
  };
  // Only this farm's mobs are answered for.
  const mobs = new Set([...treatments.rows.filter((row) => row.farm_id === farmId).map((row) => row.mob_id), ...joins.filter((row) => row.farm_id === farmId).map((row) => row.mob_id)]);
  for (const mobId of mobs) {
    // Walk back through splits, merges and farm moves (at most 200 steps), keeping treatments given before the animals joined.
    const queue: Array<{ mob: string; before: string }> = [{ mob: mobId, before: "9999-12-31" }];
    const seen = new Set<string>();
    for (let step = 0; queue.length && step < 200; step += 1) {
      const { mob, before } = queue.shift()!;
      const key = `${mob}|${before}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const row of byMob.get(mob) ?? []) if (row.treated_on <= before) add(mobId, row);
      for (const join of joins) if (join.mob_id === mob && join.on_date <= before) queue.push({ mob: join.from_mob_id, before: join.on_date });
    }
  }
  return result;
}

export type PaddockWithheld = { paddockId: string; until: string; product: string | null; jobId: string };

/**
 * Paddocks not safe to graze on `onDate` (TRT5): an active spray job's
 * withholding, from the day spraying finished, for each of the job's
 * paddocks. "Until" is the first day it's safe. Withdrawn jobs don't count.
 */
export async function paddockWithholdings(tx: OrgTx, farmId: string, onDate: string): Promise<Map<string, PaddockWithheld>> {
  const rows = await tx.query<{ paddock_id: string; from_on: string; days: number; product: string | null; job_id: string }>(
    `select p.paddock_id::text, w.from_on::text, w.days, j.product, j.id::text as job_id
       from paddock_withholdings w
       join tractor_jobs j on j.id = w.tractor_job_id and j.status = 'active'
       cross join lateral unnest(j.paddock_ids) as p(paddock_id)
      where w.farm_id = $1 and w.status = 'active' and w.from_on + w.days > $2::date and w.from_on <= $2::date`,
    [farmId, onDate],
  );
  const result = new Map<string, PaddockWithheld>();
  for (const row of rows.rows) {
    const until = addDays(row.from_on, row.days);
    const current = result.get(row.paddock_id);
    if (!current || until > current.until) result.set(row.paddock_id, { paddockId: row.paddock_id, until, product: row.product, jobId: row.job_id });
  }
  return result;
}
