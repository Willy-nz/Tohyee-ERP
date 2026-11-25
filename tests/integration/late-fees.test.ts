import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { chargeLateFees, getLateFeeSettings, lateFeesDue, runMonthlyLateFees, saveLateFeeSettings, setLateFeeExclusion } from "@/lib/invoices/late-fees";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { approveInvoice, createInvoice, deleteInvoice, getInvoice, voidInvoice } from "@/lib/invoices/service";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Examples LATE1-LATE12 in docs/ACCOUNTING-EXAMPLES.md ("Late payment fees and interest"). */
describeWithDatabase("late payment fees and interest", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("late-fees-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `late-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const hilltop = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Hilltop Cafe", isCustomer: true }))).contact;
    const invoice = async (lines: Array<Record<string, unknown>> = [{ description: "Coffee beans", quantity: "1", unitPrice: "1000.00", accountCode: "4000", taxCode: "GST" }]) => {
      const draft = (await as((tx) => createInvoice(tx, { idempotencyKey: key("i"), contactId: hilltop.id, invoiceDate: "2026-10-01", dueDate: "2026-10-31", amountsMode: "exclusive", lines }))).invoice;
      return (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }))).invoice;
    };
    const turnOn = (extra: Record<string, unknown> = {}) =>
      as((tx) => saveLateFeeSettings(tx, { enabled: true, feeAmount: "25.00", interestRate: "12", graceDays: 7, minimumOverdue: "20.00", ...extra }));
    return { org, as, hilltop, invoice, turnOn };
  }

  it("LATE1-LATE6: off until turned on; grace; a new invoice with the fee (GST) and interest (exempt); the overdue invoice unchanged", async () => {
    const w = await setup();
    const inv = await w.invoice();
    expect(inv.total).toBe("1150.00");
    // LATE1: off.
    expect((await w.as((tx) => lateFeesDue(tx, { asOf: "2026-11-30" }))).due).toEqual([]);
    await expect(w.as((tx) => chargeLateFees(tx, { asOf: "2026-11-30" }))).rejects.toThrow("Late fees are off");
    await expect(w.as((tx) => saveLateFeeSettings(tx, { enabled: true }))).rejects.toThrow("set a fee, an interest rate or both");
    const settings = await w.turnOn();
    expect(settings).toMatchObject({ enabled: true, feeAmount: "25.00", interestRate: "12", feeAccountCode: "4100" });
    expect(settings.interestAccountCode).not.toBeNull();
    // LATE2: 7 days' grace.
    expect((await w.as((tx) => lateFeesDue(tx, { asOf: "2026-11-07" }))).due).toEqual([]);
    expect((await w.as((tx) => lateFeesDue(tx, { asOf: "2026-11-08" }))).due).toHaveLength(1);

    const result = await w.as((tx) => chargeLateFees(tx, { asOf: "2026-11-30" }));
    expect(result.failed).toEqual([]);
    expect(result.charged).toHaveLength(1);
    const charge = await w.as((tx) => getInvoice(tx, result.charged[0].chargeInvoiceId));
    expect(charge).toMatchObject({ status: "draft", contactId: w.hilltop.id, invoiceDate: "2026-11-30", reference: `Late payment on ${inv.invoiceNumber}` });
    expect(charge.lines.map((line) => [line.accountCode, line.taxCode, line.netAmount, line.taxAmount])).toEqual([
      ["4100", "GST", "25.00", "3.75"],
      [settings.interestAccountCode, "EXEMPT", "11.34", "0.00"],
    ]);
    expect(charge.total).toBe("40.09");
    expect(charge.lines[1].description).toContain("1 Nov 2026 to 30 Nov 2026 (30 days)");
    // LATE3: the overdue invoice is as it was.
    expect((await w.as((tx) => getInvoice(tx, inv.id))).total).toBe("1150.00");
    // Not twice (LATE9: a draft counts), and no charge on the charge invoice itself.
    expect((await w.as((tx) => lateFeesDue(tx, { asOf: "2026-11-30" }))).due).toEqual([]);
  });

  it("LATE7-LATE9: part payments by date; next time from the day after; deleted or voided charges can be charged again", async () => {
    const w = await setup();
    const inv = await w.invoice();
    await w.turnOn({ approve: true });
    const payment = await w.as((tx) => recordPayment(tx, inv.id, { idempotencyKey: key("p"), paymentDate: "2026-11-10", amount: "650.00", bankAccountCode: "1000" }));
    const first = await w.as((tx) => chargeLateFees(tx, { asOf: "2026-11-30" }));
    expect(first.charged[0]).toMatchObject({ status: "approved" });
    const firstInvoice = await w.as((tx) => getInvoice(tx, first.charged[0].chargeInvoiceId));
    expect(firstInvoice.lines.map((line) => line.netAmount)).toEqual(["25.00", "6.85"]);

    // LATE8: from 1 December, on $500.00, and no second fee. 31 days x 500 x 12% / 365 = 5.10.
    const next = await w.as((tx) => lateFeesDue(tx, { asOf: "2026-12-31" }));
    expect(next.due).toHaveLength(1);
    expect(next.due[0]).toMatchObject({ fee: [], interest: { from: "2026-12-01", to: "2026-12-31", days: 31, amount: "5.10" }, total: "5.10" });

    // LATE7: a payment voided later counts as never made from then. Voided 1 Dec: 1150 x 31 x 12% / 365 = 11.72.
    const paymentId = (payment as { payment: { id: string } }).payment.id;
    await w.as((tx) => voidPayment(tx, inv.id, paymentId, { idempotencyKey: key("vp"), voidDate: "2026-12-01" }));
    expect((await w.as((tx) => lateFeesDue(tx, { asOf: "2026-12-31" }))).due[0].interest).toMatchObject({ amount: "11.72" });

    // LATE9: voiding the November charge: its fee and days can be charged again.
    await w.as((tx) => voidInvoice(tx, first.charged[0].chargeInvoiceId, { idempotencyKey: key("vi"), voidDate: "2026-12-31" }));
    const again = await w.as((tx) => lateFeesDue(tx, { asOf: "2026-12-31" }));
    expect(again.due[0]).toMatchObject({ feeTotal: "25.00", interest: { from: "2026-11-01", days: 61 } });
    const redo = await w.as((tx) => chargeLateFees(tx, { asOf: "2026-12-31" }));
    expect(redo.failed).toEqual([]);
    expect(redo.charged[0].chargeInvoiceId).not.toBe(first.charged[0].chargeInvoiceId);
  });

  it("LATE9 deleted draft; LATE11 customers never charged and the minimum", async () => {
    const w = await setup();
    await w.invoice();
    await w.turnOn();
    const made = await w.as((tx) => chargeLateFees(tx, { asOf: "2026-11-30" }));
    await w.as((tx) => deleteInvoice(tx, made.charged[0].chargeInvoiceId));
    expect((await w.as((tx) => lateFeesDue(tx, { asOf: "2026-11-30" }))).due).toHaveLength(1);
    await w.as((tx) => setLateFeeExclusion(tx, w.hilltop.id, true));
    expect((await w.as((tx) => lateFeesDue(tx, { asOf: "2026-11-30" }))).due).toEqual([]);
    await w.as((tx) => setLateFeeExclusion(tx, w.hilltop.id, false));
    await w.turnOn({ minimumOverdue: "2000.00" });
    expect((await w.as((tx) => lateFeesDue(tx, { asOf: "2026-11-30" }))).due).toEqual([]);
  });

  it("LATE5: the fee split like the sale's tax codes", async () => {
    const w = await setup();
    await w.invoice([
      { description: "Beans", quantity: "1", unitPrice: "200.00", accountCode: "4000", taxCode: "GST" },
      { description: "Export beans", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "ZERO" },
    ]);
    await w.turnOn({ interestRate: "" });
    const due = (await w.as((tx) => lateFeesDue(tx, { asOf: "2026-11-30" }))).due[0];
    expect(due.lines.map((line) => [line.taxCode, line.amount])).toEqual([
      ["GST", "16.67"],
      ["ZERO", "8.33"],
    ]);
    expect(due.interest).toBeNull();
  });

  it("LATE5: not registered for GST on the charge date: no GST on the fee or the interest", async () => {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { gstRegistered: false }));
    await w.invoice([{ description: "Beans", quantity: "1", unitPrice: "1000.00", accountCode: "4000", taxCode: "NONE" }]);
    await w.turnOn();
    const made = await w.as((tx) => chargeLateFees(tx, { asOf: "2026-11-30" }));
    expect(made.failed).toEqual([]);
    const charge = await w.as((tx) => getInvoice(tx, made.charged[0].chargeInvoiceId));
    // 1000 x 12% / 365 x 30 = 9.86
    expect(charge.lines.map((line) => [line.taxCode, line.netAmount, line.taxAmount])).toEqual([
      ["NONE", "25.00", "0.00"],
      ["NONE", "9.86", "0.00"],
    ]);
  });

  it("LATE10: the monthly run, once a month", async () => {
    const w = await setup();
    await w.invoice();
    await w.turnOn();
    expect(await w.as((tx) => runMonthlyLateFees(tx, "2026-12-01"))).toBeNull();
    await w.turnOn({ monthly: true });
    const run = await w.as((tx) => runMonthlyLateFees(tx, "2026-12-01"));
    expect(run?.charged).toHaveLength(1);
    expect(await w.as((tx) => runMonthlyLateFees(tx, "2026-12-15"))).toBeNull();
    expect((await w.as((tx) => getLateFeeSettings(tx))).lastMonthlyRun).toBe("2026-12-01");
    expect((await w.as((tx) => runMonthlyLateFees(tx, "2027-01-01")))?.charged).toHaveLength(1);
  });
});
