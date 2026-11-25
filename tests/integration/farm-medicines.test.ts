import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { STARTER_LISTS } from "@/lib/farming/medicine-rules";
import { addMedicine, addStarterList, cabinet, moveMedicine, removeMedicine, updateMedicine } from "@/lib/farming/medicines";
import { createMob } from "@/lib/farming/mobs";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { productStock, recordProductStock, recordTreatment } from "@/lib/farming/treatments";
import { randomUUID } from "node:crypto";
import { logTreatmentPayload } from "@/lib/farming/log-treatment";
import { currentRecords } from "@/lib/safety/records";
import { addChemical } from "@/lib/safety/register";
import type { ChemicalData } from "@/lib/safety/shared";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

/** The medicine cabinet (MED1-MED10, following common practice, not yet reviewed). A made-up farm. */
describeWithDatabase("farm medicine cabinet", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("medicines-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `meds-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const asStaff = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email, role: "farm_worker" }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    const home = (await as((tx) => saveFarm(tx, { name: "Home" })))[0];
    const runoff = (await as((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!;
    const a = await as((tx) => addPaddock(tx, { farmId: home.id, name: "A", effectiveHa: "10.00", onDate: "2026-06-01" }));
    const cows = (await as((tx) => createMob(tx, { farmId: home.id, name: "Milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 200, paddockId: a.id, onDate: "2026-09-01" }))).mob;
    return { as, asStaff, home, runoff, cows };
  }

  it("MED2 the dairy starter list, kept kinds only, not twice", async () => {
    const w = await setup();
    let slots = await w.as((tx) => addStarterList(tx, { farmId: w.home.id, list: "dairy", kinds: ["dry_cow", "teat_sealant", "teat_spray"] }));
    expect(slots.map((slot) => [slot.name, slot.kind, slot.unit, slot.badge])).toEqual([
      ["Dry cow therapy", "dry_cow", "each", "none"],
      ["Teat sealant", "teat_sealant", "each", "none"],
      ["Teat spray", "teat_spray", "L", "none"],
    ]);
    slots = await w.as((tx) => addStarterList(tx, { farmId: w.home.id, list: "dairy" }));
    expect(slots).toHaveLength(STARTER_LISTS.dairy.length);
    await expect(w.as((tx) => addStarterList(tx, { farmId: w.home.id, list: "sheep", kinds: ["dry_cow"] }))).rejects.toThrow("isn't on the sheep list");
    // MED10: farm staff can't add products.
    await expect(w.asStaff((tx) => addStarterList(tx, { farmId: w.home.id, list: "sheep" }))).rejects.toThrow("bookkeeper");
    // The products are in the farm's chemical register.
    const register = await w.as((tx) => currentRecords<ChemicalData>(tx, "chemical", { farmId: w.home.id }));
    expect(register.filter((record) => record.farmId === w.home.id)).toHaveLength(STARTER_LISTS.dairy.length);
  });

  it("MED4, MED6, MED7, MED8: used without a treatment, treatments, reorder level and expiry", async () => {
    const w = await setup();
    let slots = await w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "teat_spray", name: "Teat spray" }));
    const spray = slots[0];
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: spray.chemicalRecordId, movementType: "received", movedOn: "2026-11-01", quantity: "20", unit: "L", expiresOn: "2026-12-15" }));
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: spray.chemicalRecordId, movementType: "used", movedOn: "2026-11-08", quantity: "5", unit: "L", note: "Teat spray for the week" }));
    slots = await w.as((tx) => cabinet(tx, { farmId: w.home.id, today: "2026-11-21" }));
    expect(slots[0]).toMatchObject({ onHand: "15", unit: "L", badge: "ok", expiresOn: "2026-12-15", expiry: "soon" });
    expect(slots[0].history[0]).toMatchObject({ kind: "used", text: "Used, Teat spray for the week" });
    slots = await w.as((tx) => updateMedicine(tx, { chemicalRecordId: spray.chemicalRecordId, reorderAt: "15" }));
    expect(slots[0].badge).toBe("low");
    // An existing register product put in the cabinet, taken off by a treatment in mL.
    const tubes = await w.as((tx) => addChemical(tx, { farmId: w.home.id, name: "Lactating tubes", unit: "each" }));
    await w.as((tx) => addMedicine(tx, { chemicalRecordId: tubes.recordId, kind: "mastitis_tubes" }));
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: tubes.recordId, movementType: "received", movedOn: "2026-11-01", quantity: "24", unit: "each" }));
    await w.as((tx) => recordTreatment(tx, { farmId: w.home.id, mobId: w.cows.id, chemicalRecordId: tubes.recordId, treatedOn: "2026-11-05", quantity: "24", quantityUnit: "each", dose: "1 tube per quarter", givenBy: "Sam", head: 6, milkWithholdingHours: 96 }));
    slots = await w.as((tx) => cabinet(tx, { farmId: w.home.id, today: "2026-11-21" }));
    expect(slots.map((slot) => [slot.name, slot.onHand, slot.badge, slot.expiresOn])).toEqual([
      ["Lactating tubes", "0", "out", null],
      ["Teat spray", "15", "low", "2026-12-15"],
    ]);
  });

  it("MED5 moving stock to another farm, adding the product there", async () => {
    const w = await setup();
    const drench = (await w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "oral_drench", name: "Oral drench" })))[0];
    await expect(w.as((tx) => moveMedicine(tx, { chemicalRecordId: drench.chemicalRecordId, toFarmId: w.runoff.id, quantity: "1", unit: "L" }))).rejects.toThrow("Record a count");
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: drench.chemicalRecordId, movementType: "received", movedOn: "2026-11-01", quantity: "5", unit: "L", expiresOn: "2027-06-30" }));
    await expect(w.as((tx) => moveMedicine(tx, { chemicalRecordId: drench.chemicalRecordId, toFarmId: w.runoff.id, quantity: "6", unit: "L" }))).rejects.toThrow("Only 5 L is on hand");
    await expect(w.as((tx) => moveMedicine(tx, { chemicalRecordId: drench.chemicalRecordId, toFarmId: w.home.id, quantity: "1", unit: "L" }))).rejects.toThrow("different farm");
    const home = await w.as((tx) => moveMedicine(tx, { chemicalRecordId: drench.chemicalRecordId, toFarmId: w.runoff.id, quantity: "2", unit: "L", movedOn: "2026-11-10" }));
    expect(home[0]).toMatchObject({ onHand: "3" });
    expect(home[0].history[0]).toMatchObject({ kind: "moved_out", text: "Moved to Runoff", quantity: "2" });
    const runoff = await w.as((tx) => cabinet(tx, { farmId: w.runoff.id, today: "2026-11-21" }));
    expect(runoff.map((slot) => [slot.name, slot.kind, slot.onHand, slot.unit, slot.expiresOn])).toEqual([["Oral drench", "oral_drench", "2", "L", "2027-06-30"]]);
    expect(runoff[0].history[0]).toMatchObject({ kind: "moved_in", text: "Moved from Home" });
    // A second move finds Runoff's product by name.
    await w.as((tx) => moveMedicine(tx, { chemicalRecordId: drench.chemicalRecordId, toFarmId: w.runoff.id, quantity: "500", unit: "mL", movedOn: "2026-11-11" }));
    expect((await w.as((tx) => cabinet(tx, { farmId: w.runoff.id })))[0].onHand).toBe("2.5");
    // The organisation-wide stock list sees both farms' products.
    expect((await w.as((tx) => productStock(tx, {}))).map((product) => product.onHand).sort()).toEqual(["2.5", "2.5"]);
  });

  it("MED3, MED9: a photo of the farm's own, and taking a product out of the cabinet", async () => {
    const w = await setup();
    const slot = (await w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "vaccine", name: "5-in-1" })))[0];
    await expect(w.as((tx) => updateMedicine(tx, { chemicalRecordId: slot.chemicalRecordId, photoFileId: "00000000-0000-4000-8000-000000000000" }))).rejects.toThrow("photo taken for this farm");
    const renamed = await w.as((tx) => updateMedicine(tx, { chemicalRecordId: slot.chemicalRecordId, name: "Clostridial 5-in-1", kind: "vaccine" }));
    expect(renamed[0].name).toBe("Clostridial 5-in-1");
    expect(await w.as((tx) => removeMedicine(tx, { chemicalRecordId: slot.chemicalRecordId }))).toEqual([]);
    // Still in the register and product stock.
    expect((await w.as((tx) => productStock(tx, { farmId: w.home.id }))).map((product) => product.name)).toEqual(["Clostridial 5-in-1"]);
  });

  it("OPF2 a stock entry in another unit is refused, so the count isn't re-based or dropped", async () => {
    const w = await setup();
    const sealant = (await w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "teat_sealant", name: "Teat sealant" })))[0];
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: sealant.chemicalRecordId, movementType: "received", movedOn: "2026-11-01", quantity: "48", unit: "each" }));
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: sealant.chemicalRecordId, movementType: "counted", movedOn: "2026-11-10", quantity: "40", unit: "each" }));
    await expect(w.as((tx) => recordProductStock(tx, { chemicalRecordId: sealant.chemicalRecordId, movementType: "received", movedOn: "2026-11-12", quantity: "2", unit: "L" }))).rejects.toThrow(
      "Teat sealant is counted in each. Enter it in each.",
    );
    // A tube treatment still comes off.
    await w.as((tx) => recordTreatment(tx, { farmId: w.home.id, mobId: w.cows.id, chemicalRecordId: sealant.chemicalRecordId, treatedOn: "2026-11-15", quantity: "8", quantityUnit: "each", dose: "1 per quarter", givenBy: "Sam", head: 2 }));
    const slot = (await w.as((tx) => cabinet(tx, { farmId: w.home.id, today: "2026-11-21" })))[0];
    expect([slot.onHand, slot.unit, slot.notCounted.length]).toEqual(["32", "each", 0]);
    // mL adds to litres.
    const drench = (await w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "oral_drench", name: "Oral drench" }))).find((entry) => entry.name === "Oral drench")!;
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: drench.chemicalRecordId, movementType: "received", movedOn: "2026-11-01", quantity: "5", unit: "L" }));
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: drench.chemicalRecordId, movementType: "used", movedOn: "2026-11-02", quantity: "500", unit: "mL" }));
    await expect(w.as((tx) => recordProductStock(tx, { chemicalRecordId: drench.chemicalRecordId, movementType: "used", movedOn: "2026-11-03", quantity: "1", unit: "kg" }))).rejects.toThrow("Enter it in L or mL.");
    const slots = await w.as((tx) => cabinet(tx, { farmId: w.home.id, today: "2026-11-21" }));
    expect(slots.find((entry) => entry.name === "Oral drench")).toMatchObject({ onHand: "4.5", unit: "L" });
  });

  it("OPF2 a move onto the other farm's same-named product counted in another unit is refused", async () => {
    const w = await setup();
    const drench = (await w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "oral_drench", name: "Oral drench" })))[0];
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: drench.chemicalRecordId, movementType: "received", movedOn: "2026-11-01", quantity: "5", unit: "L" }));
    const theirs = (await w.as((tx) => addMedicine(tx, { farmId: w.runoff.id, kind: "oral_drench", name: "Oral drench", unit: "kg" })))[0];
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: theirs.chemicalRecordId, movementType: "counted", movedOn: "2026-11-05", quantity: "10", unit: "kg" }));
    await expect(w.as((tx) => moveMedicine(tx, { chemicalRecordId: drench.chemicalRecordId, toFarmId: w.runoff.id, quantity: "1", unit: "L", movedOn: "2026-11-10" }))).rejects.toThrow("is counted in kg");
    const runoff = (await w.as((tx) => cabinet(tx, { farmId: w.runoff.id, today: "2026-11-21" })))[0];
    expect([runoff.onHand, runoff.unit]).toEqual(["10", "kg"]);
    const home = (await w.as((tx) => cabinet(tx, { farmId: w.home.id, today: "2026-11-21" })))[0];
    expect(home.onHand).toBe("5");
  });

  it("OPF2 an older entry in another unit is listed as not counted, not dropped, and the first entry's unit stays", async () => {
    const w = await setup();
    const sealant = (await w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "teat_sealant", name: "Teat sealant" })))[0];
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: sealant.chemicalRecordId, movementType: "counted", movedOn: "2026-11-10", quantity: "40", unit: "each" }));
    // As if saved before units were checked: put in directly.
    await w.as((tx) =>
      tx.query("insert into farm_product_stock (chemical_record_id, farm_id, movement_type, moved_on, quantity, unit, created_by_email) values ($1, $2, 'received', '2026-11-12', 2, 'L', 'someone@example.com')", [sealant.chemicalRecordId, w.home.id]),
    );
    const slot = (await w.as((tx) => cabinet(tx, { farmId: w.home.id, today: "2026-11-21" })))[0];
    expect([slot.onHand, slot.unit]).toEqual(["40", "each"]);
    expect(slot.notCounted.map((entry) => [entry.kind, entry.quantity, entry.unit])).toEqual([["received", "2", "L"]]);
  });

  it("OPF3 the same stock entry or move sent twice with its operation id is recorded once", async () => {
    const w = await setup();
    const drench = (await w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "oral_drench", name: "Oral drench" })))[0];
    const received = { chemicalRecordId: drench.chemicalRecordId, movementType: "received", movedOn: "2026-11-01", quantity: "5", unit: "L", operationId: randomUUID() };
    await w.as((tx) => recordProductStock(tx, received));
    await w.as((tx) => recordProductStock(tx, received));
    let slot = (await w.as((tx) => cabinet(tx, { farmId: w.home.id, today: "2026-11-21" })))[0];
    expect(slot.onHand).toBe("5");
    await expect(w.as((tx) => recordProductStock(tx, { ...received, quantity: "6" }))).rejects.toThrow("already sent with different details");
    const move = { chemicalRecordId: drench.chemicalRecordId, toFarmId: w.runoff.id, quantity: "2", unit: "L", movedOn: "2026-11-10", operationId: randomUUID() };
    await w.as((tx) => moveMedicine(tx, move));
    await w.as((tx) => moveMedicine(tx, move));
    slot = (await w.as((tx) => cabinet(tx, { farmId: w.home.id, today: "2026-11-21" })))[0];
    const runoff = (await w.as((tx) => cabinet(tx, { farmId: w.runoff.id, today: "2026-11-21" })))[0];
    expect([slot.onHand, runoff.onHand]).toEqual(["3", "2"]);
    // Without an id, two sends are two entries (two deliveries can be real).
    await w.as((tx) => recordProductStock(tx, { ...received, operationId: undefined }));
    await w.as((tx) => recordProductStock(tx, { ...received, operationId: undefined }));
    slot = (await w.as((tx) => cabinet(tx, { farmId: w.home.id, today: "2026-11-21" })))[0];
    expect(slot.onHand).toBe("13");
  });

  it("OPF3 a second product of the same name isn't added; a resend of the same add is the same product", async () => {
    const w = await setup();
    const operationId = randomUUID();
    await w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "oral_drench", name: "Oral drench", operationId }));
    const again = await w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "oral_drench", name: "Oral drench", operationId }));
    expect(again.map((slot) => slot.name)).toEqual(["Oral drench"]);
    await expect(w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "oral_drench", name: " oral DRENCH " }))).rejects.toThrow("already in this farm's chemical register");
    // Another farm can have its own.
    await w.as((tx) => addMedicine(tx, { farmId: w.runoff.id, kind: "oral_drench", name: "Oral drench" }));
  });

  it("OPF2 a treatment can't take stock off another farm's product", async () => {
    const w = await setup();
    const theirs = (await w.as((tx) => addMedicine(tx, { farmId: w.runoff.id, kind: "oral_drench", name: "Runoff drench" })))[0];
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: theirs.chemicalRecordId, movementType: "received", movedOn: "2026-11-01", quantity: "5", unit: "L" }));
    await expect(
      w.as((tx) => recordTreatment(tx, { farmId: w.home.id, mobId: w.cows.id, chemicalRecordId: theirs.chemicalRecordId, treatedOn: "2026-11-05", quantity: "1", quantityUnit: "L", dose: "x", givenBy: "Sam", head: 10 })),
    ).rejects.toThrow("kept on another farm");
    const runoff = (await w.as((tx) => cabinet(tx, { farmId: w.runoff.id, today: "2026-11-21" })))[0];
    expect(runoff.onHand).toBe("5");
  });

  it("OPF4 a treatment from Log, with the product picked from the cabinet, takes its stock off", async () => {
    const w = await setup();
    const drench = (await w.as((tx) => addMedicine(tx, { farmId: w.home.id, kind: "oral_drench", name: "Oral drench" })))[0];
    await w.as((tx) => recordProductStock(tx, { chemicalRecordId: drench.chemicalRecordId, movementType: "received", movedOn: "2026-11-01", quantity: "5", unit: "L" }));
    const payload = logTreatmentPayload(w.cows.id, 200, { day: "2026-11-05", product: "Oral drench", chemicalRecordId: drench.chemicalRecordId, dose: "20 mL a head", quantity: "4", unit: "L", givenTime: "07:30", meat: "14", milk: "", givenBy: "Sam" });
    const { treatment } = await w.as((tx) => recordTreatment(tx, { ...payload, farmId: w.home.id, operationId: randomUUID() }));
    expect(treatment).toMatchObject({ chemicalRecordId: drench.chemicalRecordId, quantity: "4", quantityUnit: "L", givenTime: "07:30" });
    const slot = (await w.as((tx) => cabinet(tx, { farmId: w.home.id, today: "2026-11-21" })))[0];
    expect(slot.onHand).toBe("1");
    expect(slot.history.some((entry) => entry.kind === "treatment")).toBe(true);
  });
});
