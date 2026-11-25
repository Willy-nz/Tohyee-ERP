import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts } from "@/lib/bank/accounts";
import { createBankTransaction } from "@/lib/bank/transactions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { addManualFuel, chooseFuelLine, fuelQuarter, saveFuelQuarter, saveFuelUser } from "@/lib/farming/fuel-refund";
import { setFarmingEnabled } from "@/lib/farming/paddocks";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

const key = (prefix: string) => `${prefix}-${randomUUID()}`;

/** The fuel excise refund (FUEL1-FUEL12, following common practice, not yet reviewed). A made-up farm. */
describeWithDatabase("farm fuel excise refund", () => {
  let server: TestServer;
  let owner: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("fuel-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("FUEL2-FUEL7: petrol and diesel from bills and spend money, the tank, shares and the refund", async () => {
    const org = "fuel-1-co";
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const asStaff = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email, role: "farm_worker" }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    await as((tx) => createAccount(tx, { code: "6159", name: "Fuel", accountType: "expense" }));
    const supplier = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Rural Fuels", isSupplier: true }))).contact;
    const bill = async (billDate: string, lines: unknown[]) => {
      const draft = await as((tx) => createBill(tx, { idempotencyKey: key("bill"), contactId: supplier.id, billDate, dueDate: "2026-10-20", supplierInvoiceNumber: key("S"), amountsMode: "exclusive", lines }));
      return (await as((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("a") }))).bill;
    };
    await bill("2026-07-15", [
      { description: "ULP 91", quantity: "600", unitPrice: "2.2", accountCode: "6159", taxCode: "GST" },
      { description: "Diesel", quantity: "1000", unitPrice: "1.6", accountCode: "6159", taxCode: "GST" },
      { description: "Delivery fee", quantity: "1", unitPrice: "40", accountCode: "6159", taxCode: "GST" },
    ]);
    // Outside the quarter: not counted.
    await bill("2026-10-02", [{ description: "Petrol 100L", quantity: "1", unitPrice: "220", accountCode: "6159", taxCode: "GST" }]);
    const bank = (await as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    await as((tx) =>
      createBankTransaction(tx, { idempotencyKey: key("spend"), kind: "spend", accountId: bank.id, contactId: supplier.id, date: "2026-08-10", amountsMode: "inclusive", lines: [{ description: "Fuel stop", accountCode: "6159", amount: "120.00", taxCode: "GST" }] }),
    );

    let quarter = await as((tx) => fuelQuarter(tx, { quarterEnd: "2026-09-30", today: "2026-11-21" }));
    expect(quarter.petrol.map((line) => [line.description, line.litres])).toEqual([["ULP 91", "600.00"]]);
    expect(quarter.diesel.map((line) => [line.description, line.litres])).toEqual([["Diesel", "1000.00"]]);
    expect(quarter.unsure.map((line) => line.description)).toEqual(["Delivery fee", "Fuel stop"]);
    expect(quarter).toMatchObject({ dieselLitres: "1000.00", dueDate: "2026-12-31", timing: "open", missingLitres: 0 });

    // FUEL2, FUEL3: the fuel stop was petrol with no litres; the fee isn't fuel.
    const stop = quarter.unsure.find((line) => line.description === "Fuel stop")!;
    const fee = quarter.unsure.find((line) => line.description === "Delivery fee")!;
    await as((tx) => chooseFuelLine(tx, { source: stop.source, sourceId: stop.sourceId, fuelType: "petrol" }));
    await as((tx) => chooseFuelLine(tx, { source: fee.source, sourceId: fee.sourceId, fuelType: "not_fuel" }));
    quarter = await as((tx) => fuelQuarter(tx, { quarterEnd: "2026-09-30", today: "2026-11-21" }));
    expect(quarter.missingLitres).toBe(1);
    expect(quarter.result).toBeNull();
    await as((tx) => chooseFuelLine(tx, { source: stop.source, sourceId: stop.sourceId, fuelType: "petrol", litres: "50" }));
    // FUEL4: petrol on a fuel card, by hand.
    await as((tx) => addManualFuel(tx, { boughtOn: "2026-09-01", description: "Fuel card statement", fuelType: "petrol", litres: "350" }));

    // FUEL6: what uses the petrol, and this quarter's shares.
    await as((tx) => saveFuelUser(tx, { name: "Red quad", kind: "quad" }));
    await as((tx) => saveFuelUser(tx, { name: "Generator", kind: "generator" }));
    const users = await as((tx) => saveFuelUser(tx, { name: "Ute", kind: "road_vehicle" }));
    expect(users.find((user) => user.name === "Ute")?.roadLicensed).toBe(true);
    const id = (name: string) => users.find((user) => user.name === name)!.id;
    await expect(as((tx) => saveFuelQuarter(tx, { quarterEnd: "2026-09-30", shares: [{ userId: id("Red quad"), percent: "80" }, { userId: id("Ute"), percent: "30" }] }))).rejects.toThrow("can't be more than 100%");
    // FUEL5: tank 200 L at the start, 300 L at the end.
    await as((tx) =>
      saveFuelQuarter(tx, {
        quarterEnd: "2026-09-30",
        opening: "200",
        closing: "300",
        shares: [
          { userId: id("Red quad"), percent: "60" },
          { userId: id("Generator"), percent: "10" },
          { userId: id("Ute"), percent: "30" },
        ],
      }),
    );
    quarter = await as((tx) => fuelQuarter(tx, { quarterEnd: "2026-09-30", today: "2026-11-21" }));
    // 600 + 50 + 350 = 1,000 bought; 200 + 1,000 − 300 = 900 used; 70% off-road.
    expect(quarter.result).toMatchObject({ bought: "1000.00", used: "900.00", offRoadLitres: "630.00", refund: "507.32", gst: "66.17", excise: "441.15", problems: [] });
    // TXF5: code the refund with GST only when registered for GST.
    expect(quarter).toMatchObject({ gstRegistered: true, handAddedPetrol: true });
    await as((tx) => tx.query("update organisation_settings set gst_registered_until = '2026-06-30' where id = true"));
    expect((await as((tx) => fuelQuarter(tx, { quarterEnd: "2026-09-30", today: "2026-11-21" }))).gstRegistered).toBe(false);
    await as((tx) => tx.query("update organisation_settings set gst_registered_until = null where id = true"));

    // FUEL5, FUEL6: the next quarter starts from this one's tank and shares.
    const next = await as((tx) => fuelQuarter(tx, { quarterEnd: "2026-12-31", today: "2026-11-21" }));
    expect(next).toMatchObject({ opening: "300.00", openingTyped: false, timing: "not_ended" });
    expect(next.users.map((user) => [user.name, user.percent])).toEqual([
      ["Generator", "10.00"],
      ["Red quad", "60.00"],
      ["Ute", "30.00"],
    ]);
    expect(next.petrol.map((line) => line.description)).toEqual(["Petrol 100L"]);

    // FUEL9: late, and too old.
    expect((await as((tx) => fuelQuarter(tx, { quarterEnd: "2026-06-30", today: "2026-11-21" }))).timing).toBe("late");
    expect((await as((tx) => fuelQuarter(tx, { quarterEnd: "2024-06-30", today: "2026-11-21" }))).timing).toBe("too_old");
    await expect(as((tx) => fuelQuarter(tx, { quarterEnd: "2026-09-15" }))).rejects.toThrow("A quarter ends");

    // The books' figures are for bookkeepers and owners.
    await expect(asStaff((tx) => fuelQuarter(tx, { quarterEnd: "2026-09-30" }))).rejects.toThrow("bookkeeper");
  });
});
