import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { FARM_POST_TOOLS } from "@/lib/ai/farm-post-tools";
import type { ToolContext } from "@/lib/ai/tools";
import type { OrgTx } from "@/lib/db/org-transaction";
import { createAnimal, listAnimals, moveAnimals } from "@/lib/farming/animals";
import { moveMobToFarm } from "@/lib/farming/mob-farm-move";
import { createMob, getMob, listMobs, mobAction } from "@/lib/farming/mobs";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { farmTimeline } from "@/lib/farming/timeline";
import { recordTreatment } from "@/lib/farming/treatments";
import { headCount, listMovements, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

/** Moving stock to another farm in the same organisation (OPF7-OPF13, following common practice, not yet reviewed). */
describeWithDatabase("moving stock to another farm", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("farm-move-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `farm-move-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const asStaff = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email, role: "farm_worker" }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    await as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    await as((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2026-06-01" }));
    await as((tx) => setOpenings(tx, { lines: [{ kind: "dairy_cattle", classCode: "ma_cows", head: 380, value: "950000.00" }] }));
    const home = (await as((tx) => saveFarm(tx, { name: "Home" })))[0];
    const runoff = (await as((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!;
    const a = await as((tx) => addPaddock(tx, { farmId: home.id, name: "A", effectiveHa: "10.00", onDate: "2026-06-01" }));
    const b = await as((tx) => addPaddock(tx, { farmId: runoff.id, name: "B", effectiveHa: "8.00", onDate: "2026-06-01" }));
    // Farm staff here work on both farms.
    await as((tx) => tx.query("insert into farm_member_scopes (user_id, all_farms, updated_by_email) values ($1, false, $2)", [owner.id, owner.email]));
    await as((tx) => tx.query("insert into farm_member_farms (user_id, farm_id) values ($1, $2), ($1, $3)", [owner.id, home.id, runoff.id]));
    const milkers = (await as((tx) => createMob(tx, { farmId: home.id, name: "Milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 200, paddockId: a.id, onDate: "2026-09-01" }))).mob;
    return { as, asStaff, home, runoff, a, b, milkers };
  }

  const cows = async (w: Awaited<ReturnType<typeof setup>>) => (await w.as((tx) => headCount(tx, { yearEnd: "2027-05-31" }))).rows.find((row) => row.classCode === "ma_cows")!;

  it("OPF7 moves a whole mob as a new mob: closed on Home, open on Runoff, and nothing in the books", async () => {
    const w = await setup();
    const before = await cows(w);
    const result = await w.asStaff((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, toPaddockId: w.b.id, onDate: "2026-11-10" }));
    expect(result.from).toMatchObject({ head: 0, status: "closed", farmId: w.home.id, paddock: null });
    expect(result.to).toMatchObject({ name: "Milkers from Home", head: 200, kind: "dairy_cattle", classCode: "ma_cows", farmId: w.runoff.id, paddock: { name: "B", inOn: "2026-11-10" } });
    expect(result.message).toBe("200 moved from Milkers on Home to Milkers from Home on Runoff. The books' head count doesn't change: it's a move, not a sale.");
    expect(result.nait).toBe("Tohyee doesn't tell NAIT. If this move needs recording in NAIT, record it with OSPRI.");
    expect(result.warning).toBeNull();
    // The movement history shows where they came from, on both farms.
    const out = (await w.as((tx) => getMob(tx, w.milkers.id))).events[0];
    expect(out).toMatchObject({ eventType: "farm_out", headChange: -200, headAfter: 0, otherMobId: result.to.id, otherMobName: "Milkers from Home", otherFarmName: "Runoff" });
    const came = (await w.as((tx) => getMob(tx, result.to.id))).events;
    expect(came.map((event) => [event.eventType, event.headChange, event.otherMobName, event.otherFarmName])).toEqual([["farm_in", 200, "Milkers", "Home"]]);
    expect(result.to.createdOn).toBe("2026-11-10");
    const timeline = await w.as((tx) => farmTimeline(tx, { farmId: w.runoff.id, from: "2026-11-01", to: "2026-11-30" }));
    expect(timeline.items.map((item) => item.title)).toContain("Milkers from Home: 200 came from Milkers on Home");
    // Not a sale, purchase, death or birth anywhere: no livestock movement, the same head count.
    expect(await w.as((tx) => listMovements(tx))).toEqual([]);
    expect(await cows(w)).toEqual(before);
    expect(before).toMatchObject({ opening: 380, sold: 0, bought: 0, died: 0, births: 0, closing: 380 });
    // An archived farm can't take stock; a farm the person can't see is "not found"; the same farm is refused.
    const other = (await w.as((tx) => createMob(tx, { farmId: w.home.id, name: "Spare", kind: "dairy_cattle", classCode: "ma_cows", head: 5, onDate: "2026-09-01" }))).mob;
    await expect(w.as((tx) => moveMobToFarm(tx, other.id, { toFarmId: w.home.id }))).rejects.toThrow("already on Home");
    await w.as((tx) => tx.query("delete from farm_member_farms where user_id = $1 and farm_id = $2", [owner.id, w.runoff.id]));
    await expect(w.asStaff((tx) => moveMobToFarm(tx, other.id, { toFarmId: w.runoff.id }))).rejects.toThrow("Farm not found");
    await w.as((tx) => saveFarm(tx, { id: w.runoff.id, name: "Runoff", isActive: false }));
    await expect(w.as((tx) => moveMobToFarm(tx, other.id, { toFarmId: w.runoff.id }))).rejects.toThrow("Runoff is archived");
  });

  it("OPF8 moves part of a mob, with the tagged animals chosen going onto the other farm's register", async () => {
    const w = await setup();
    const ids: string[] = await w.as(async (tx) => {
      const made: string[] = [];
      for (let n = 1; n <= 160; n += 1) made.push((await createAnimal(tx, { farmId: w.home.id, kind: "dairy_cattle", tag: `T${n}`, mobId: w.milkers.id, onDate: "2026-09-01" })).id);
      return made;
    });
    await expect(w.as((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head: 201, onDate: "2026-11-10" }))).rejects.toThrow("Milkers has 200 head");
    await expect(w.as((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head: 50, animalIds: ids.slice(0, 9), onDate: "2026-11-10" }))).rejects.toThrow("Choose at least 1 more");
    // A tag already on Runoff's register is refused, and nothing moves.
    await w.as((tx) => createAnimal(tx, { farmId: w.runoff.id, kind: "dairy_cattle", tag: "T3" }));
    await expect(w.as((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head: 50, animalIds: ids.slice(0, 10), onDate: "2026-11-10" }))).rejects.toThrow("T3 is already on Runoff's register");
    expect((await w.as((tx) => getMob(tx, w.milkers.id))).mob.head).toBe(200);
    const result = await w.as((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head: 50, animalIds: ids.slice(10, 20), onDate: "2026-11-10" }));
    expect(result.from).toMatchObject({ head: 150, tagged: 150, status: "active", paddock: { name: "A" } });
    expect(result.to).toMatchObject({ head: 50, tagged: 10, farmId: w.runoff.id, paddock: null });
    const there = await w.as((tx) => listAnimals(tx, { farmId: w.runoff.id }));
    expect(there.map((animal) => animal.tag).sort()).toEqual(["T11", "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T19", "T20", "T3"].sort());
    expect(there.find((animal) => animal.tag === "T11")?.mob?.id).toBe(result.to.id);
    expect((await w.as((tx) => listAnimals(tx, { farmId: w.home.id }))).length).toBe(150);
    // Moving tags between mobs on different farms points to this step.
    const spare = (await w.as((tx) => createMob(tx, { farmId: w.runoff.id, name: "Spare", kind: "dairy_cattle", classCode: "ma_cows", head: 5, onDate: "2026-09-01" }))).mob;
    await expect(w.as((tx) => moveAnimals(tx, { animalIds: [ids[30]], toMobId: spare.id, onDate: "2026-11-11" }))).rejects.toThrow('Milkers is on another farm. Use "Move to another farm" on Milkers');
    expect(await w.as((tx) => listMovements(tx))).toEqual([]);
  });

  it("OPF9 moves into a mob already on the other farm under the merge rules", async () => {
    const w = await setup();
    const dry = (await w.as((tx) => createMob(tx, { farmId: w.runoff.id, name: "Dry cows", kind: "dairy_cattle", classCode: "ma_cows", head: 80, paddockId: w.b.id, onDate: "2026-09-01" }))).mob;
    const heifers = (await w.as((tx) => createMob(tx, { farmId: w.runoff.id, name: "Heifers", kind: "dairy_cattle", classCode: "r2_heifers", head: 40, onDate: "2026-09-01" }))).mob;
    await expect(w.as((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head: 50, intoMobId: heifers.id, onDate: "2026-11-10" }))).rejects.toThrow("change the class first");
    await expect(w.as((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head: 50, intoMobId: w.milkers.id, onDate: "2026-11-10" }))).rejects.toThrow("isn't on Runoff");
    const result = await w.as((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head: 50, intoMobId: dry.id, onDate: "2026-11-10" }));
    expect(result.to).toMatchObject({ id: dry.id, head: 130, paddock: { name: "B" } });
    expect(result.from.head).toBe(150);
    expect(await w.as((tx) => listMovements(tx))).toEqual([]);
  });

  it("OPF10 withholding goes with the animals, warns before the move, and a merged mob takes the later dates", async () => {
    const w = await setup();
    const treat = (fields: Record<string, unknown>) => w.as((tx) => recordTreatment(tx, { dose: "20 mL a head", givenBy: "Sam", product: "Pour-on", ...fields }));
    await treat({ farmId: w.home.id, mobId: w.milkers.id, head: 200, treatedOn: "2026-11-08", meatWithholdingDays: 28, milkWithholdingHours: 96 });
    const dry = (await w.as((tx) => createMob(tx, { farmId: w.runoff.id, name: "Dry cows", kind: "dairy_cattle", classCode: "ma_cows", head: 80, onDate: "2026-09-01" }))).mob;
    await treat({ farmId: w.runoff.id, mobId: dry.id, head: 80, treatedOn: "2026-10-20", meatWithholdingDays: 30 });
    expect((await w.as((tx) => getMob(tx, dry.id))).mob.withholding).toEqual({ meatSafeOn: "2026-11-19", milkSafeFrom: null });

    const moved = await w.as((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head: 50, onDate: "2026-11-10" }));
    expect(moved.warning).toBe("These animals are within a withholding period (safe for slaughter from 2026-12-06, milk safe from 2026-11-13). It goes with them to Runoff.");
    expect(moved.message).toContain(moved.warning!);
    expect(moved.to.withholding).toEqual({ meatSafeOn: "2026-12-06", milkSafeFrom: "2026-11-13" });
    // The new farm's own list (what its screens and "what's due" read) sees it.
    const runoffMobs = await w.as((tx) => listMobs(tx, { farmId: w.runoff.id }));
    expect(runoffMobs.find((mob) => mob.id === moved.to.id)?.withholding).toEqual({ meatSafeOn: "2026-12-06", milkSafeFrom: "2026-11-13" });
    // A treatment on Home after the move doesn't follow the 50 that left.
    await treat({ farmId: w.home.id, mobId: w.milkers.id, head: 150, treatedOn: "2026-11-15", meatWithholdingDays: 60 });
    expect((await w.as((tx) => getMob(tx, moved.to.id))).mob.withholding).toEqual({ meatSafeOn: "2026-12-06", milkSafeFrom: "2026-11-13" });
    expect((await w.as((tx) => getMob(tx, w.milkers.id))).mob.withholding?.meatSafeOn).toBe("2027-01-14");
    // A sale from Runoff within the period is saved with the warning (TRT4).
    const sale = await w.as((tx) => mobAction(tx, moved.to.id, { action: "sell", head: 5, onDate: "2026-11-20" }));
    expect(sale.message).toContain("is within a withholding period (safe for slaughter from 2026-12-06)");
    // Into Dry cows: the merged mob takes the later dates.
    const merged = await w.as((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head: 10, intoMobId: dry.id, onDate: "2026-11-12" }));
    expect(merged.to.withholding).toEqual({ meatSafeOn: "2026-12-06", milkSafeFrom: "2026-11-13" });
  });

  it("OPF11 a move sent twice from a phone is recorded once; different details with the same id are refused", async () => {
    const w = await setup();
    const operationId = randomUUID();
    const send = (head: number) => w.asStaff((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head, onDate: "2026-11-10", operationId }));
    const first = await send(50);
    const again = await send(50);
    expect(again.message).toBe("Already recorded.");
    expect(again.to.id).toBe(first.to.id);
    await expect(send(49)).rejects.toThrow("already sent with different details");
    expect((await w.as((tx) => getMob(tx, w.milkers.id))).mob.head).toBe(150);
    expect((await w.as((tx) => listMobs(tx, { farmId: w.runoff.id }))).map((mob) => mob.head)).toEqual([50]);
    // One operation: when the Runoff half is refused, Home isn't changed either.
    await expect(w.as((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head: 10, toPaddockId: w.a.id, onDate: "2026-11-11" }))).rejects.toThrow("Paddock not found on this farm");
    expect((await w.as((tx) => getMob(tx, w.milkers.id))).mob.head).toBe(150);
  });

  it("OPF12 moves both ways, and the withholding isn't counted twice", async () => {
    const w = await setup();
    await w.as((tx) => recordTreatment(tx, { farmId: w.home.id, mobId: w.milkers.id, head: 200, treatedOn: "2026-11-08", meatWithholdingDays: 28, milkWithholdingHours: 96, dose: "x", givenBy: "Sam", product: "Pour-on" }));
    const out = await w.as((tx) => moveMobToFarm(tx, w.milkers.id, { toFarmId: w.runoff.id, head: 50, onDate: "2026-11-10" }));
    const back = await w.as((tx) => moveMobToFarm(tx, out.to.id, { toFarmId: w.home.id, intoMobId: w.milkers.id, onDate: "2026-11-20" }));
    expect(back.to).toMatchObject({ id: w.milkers.id, head: 200, withholding: { meatSafeOn: "2026-12-06", milkSafeFrom: "2026-11-13" } });
    expect(back.from).toMatchObject({ head: 0, status: "closed" });
    const history = (await w.as((tx) => getMob(tx, w.milkers.id))).events.map((event) => [event.eventType, event.headChange, event.otherFarmName]);
    expect(history.slice(0, 2)).toEqual([
      ["farm_in", 50, "Runoff"],
      ["farm_out", -50, "Runoff"],
    ]);
    expect(await w.as((tx) => listMovements(tx))).toEqual([]);
    expect(await cows(w)).toMatchObject({ opening: 380, closing: 380, sold: 0, bought: 0 });
  });

  it("OPF7 the AI's move_mob_to_farm tool calls the same step, once per idempotency key", async () => {
    const w = await setup();
    const tool = FARM_POST_TOOLS.find((entry) => entry.name === "move_mob_to_farm")!;
    expect(tool.level).toBe("post");
    const context = { source: "ai-test", role: "owner", organisationId: "x", accessLevel: "post", grantedAccessLevel: "post" } as unknown as ToolContext;
    const args = { mobId: w.milkers.id, toFarmId: w.runoff.id, head: 20, onDate: "2026-11-10", idempotencyKey: "farm-move-0001" };
    const first = (await w.as((tx) => tool.run(tx, args, context))) as { message: string; nait: string | null };
    expect(first.message).toContain("20 moved from Milkers on Home");
    expect(first.nait).toContain("NAIT");
    expect(((await w.as((tx) => tool.run(tx, args, context))) as { message: string }).message).toBe("Already recorded.");
    expect((await w.as((tx) => getMob(tx, w.milkers.id))).mob.head).toBe(180);
  });
});
