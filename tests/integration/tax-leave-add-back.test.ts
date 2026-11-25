import { afterAll, beforeAll, expect, it } from "vitest";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { LEAVE_ADD_BACK_LABEL, LEAVE_REVERSAL_LABEL } from "@/lib/tax/income/leave-add-back";
import { addAdjustment, buildIncomeTax, getIncomeTaxSettings, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** TXF4: leave owed at balance date and the 63-day rule (s EA 4); following common practice, not yet reviewed. */
describeWithDatabase("income tax: leave owed at balance date (TXF4)", () => {
  let server: TestServer;
  let owner: SessionUser;
  const org = "pukeko-orchard";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("leave-addback-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, org);
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: false, version: settings.version }));
    await as(async (tx) => {
      await createAccount(tx, { code: "6911", name: "Leave expense", accountType: "expense" });
      await createAccount(tx, { code: "2311", name: "Employee entitlements", accountType: "current_liability" });
      await tx.query(
        `update organisation_settings set payroll_leave_expense_account_id = (select id from accounts where code = '6911'),
                payroll_leave_liability_account_id = (select id from accounts where code = '2311') where id = true`,
      );
    });
    const journal = (date: string, amount: string) =>
      as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: date, reference: "Leave liability", lines: [{ accountCode: "6911", debitAmount: amount }, { accountCode: "2311", creditAmount: amount }] }));
    await as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: "2025-08-01", reference: "Sales", lines: [{ accountCode: "1000", debitAmount: "90000.00" }, { accountCode: "4000", creditAmount: "90000.00" }] }));
    await journal("2026-03-31", "6327.45");
    // After balance date: shouldn't count in the balance at 31 March.
    await journal("2026-04-30", "500.00");
  }, 300_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("suggests the add-back but never adds it by itself", async () => {
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    if (!report.supported) throw new Error("not supported");
    expect(report.leaveAddBack).toMatchObject({ accountCode: "2311", owedAtYearEnd: "6327.45", payBy: "2026-06-02", lastYearAddBack: "0.00", addBackAdded: false });
    expect(report.notes.join(" ")).toContain("s EA 4");
    // The leave expense is still deducted in full until a person adds the adjustment.
    expect(report.workpaper.adjustments).toEqual([]);
    expect(report.workpaper.taxableIncome).toBe("83672.55");
  });

  it("once added, it counts, the note goes, and next year deducts it", async () => {
    // 1,840.00 of it was paid in leave by 2 June: 4,487.45 is added back.
    await as((tx) => addAdjustment(tx, { idempotencyKey: key("adj"), incomeYear: 2026, description: LEAVE_ADD_BACK_LABEL, amount: "4487.45" }));
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-10-16" }));
    if (!report.supported) throw new Error("not supported");
    expect(report.leaveAddBack?.addBackAdded).toBe(true);
    expect(report.notes.join(" ")).not.toContain("s EA 4");
    expect(report.workpaper.taxableIncome).toBe("88160.00");

    const next = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2026-10-16" }));
    if (!next.supported) throw new Error("not supported");
    expect(next.leaveAddBack).toMatchObject({ owedAtYearEnd: "6827.45", lastYearAddBack: "4487.45", reversalAdded: false });
    expect(next.notes.join(" ")).toContain("s DB 51");
    await as((tx) => addAdjustment(tx, { idempotencyKey: key("adj"), incomeYear: 2027, description: LEAVE_REVERSAL_LABEL, amount: "-4487.45" }));
    const after = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2026-10-16" }));
    if (!after.supported) throw new Error("not supported");
    expect(after.leaveAddBack?.reversalAdded).toBe(true);
    expect(after.notes.join(" ")).not.toContain("s DB 51");
  });
});
