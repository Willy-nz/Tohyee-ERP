import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { getIrdPeriod } from "@/lib/payroll/ird-payments";
import { getPayRunPaydayFiling } from "@/lib/payroll/payday-filing-service";
import { getPayslip } from "@/lib/payroll/payslips";
import { createPayItem } from "@/lib/payroll/pay-items";
import { approvePayRun, createPayRun, getPayRun, listPayRunPostings, voidPayRun } from "@/lib/payroll/pay-runs";
import { payrollReconciliation } from "@/lib/payroll/report-reconciliation";
import { payrollSummaryReport } from "@/lib/payroll/reports";
import { recordWagePayment } from "@/lib/payroll/wage-payments";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "payroll-add-on-co";

/**
 * Examples PAO1-PAO9 in docs/ACCOUNTING-EXAMPLES.md (Payroll as an add-on,
 * following common practice, not yet reviewed). A made-up organisation runs
 * payroll with Accounting off, then turns Accounting on.
 */
describeWithDatabase("payroll as an add-on (PAO1-PAO9)", () => {
  let server: TestServer;
  let owner: SessionUser;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  let group = "";
  let employee = "";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const journalCount = async () => Number((await as((tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"))).rows[0].count);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-add-on-test-secret-key-32-characters!!";
    server = await startTestServer();
    owner = await createTestUser("owner@payroll-add-on.test");
    await createTestOrganisation(owner, ORG);
    group = (await as((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Fortnightly", payFrequency: "fortnightly" }))).group.id;
    employee = (
      await as((tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          firstName: "Mere",
          lastName: "Tipene",
          taxCode: "M",
          irdNumber: "123456789",
          kiwiSaverStatus: "enrolled",
          kiwiSaverEmployeeRate: "3.5",
          kiwiSaverEmployerRate: "3.5",
          esctRate: "17.5",
          studentLoan: false,
          payBasis: "salary",
          annualSalary: "52000.00",
          payFrequency: "fortnightly",
          payGroupId: group,
          startDate: "2026-04-01",
          bankAccount: "03-1234-0123456-00",
        }),
      )
    ).employee.id;
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("PAO1: Payroll counts as an app that's on; with it off, payroll is refused", async () => {
    await as((tx) => updateOrganisationSettings(tx, { accountingEnabled: false }));
    await expect(as((tx) => updateOrganisationSettings(tx, { payrollEnabled: false }))).rejects.toThrow(/Keep at least one of Accounting, Payroll, CRM or Analytics on/);
    await as((tx) => updateOrganisationSettings(tx, { analyticsEnabled: true }));
    await as((tx) => updateOrganisationSettings(tx, { payrollEnabled: false }));
    await expect(as((tx) => getPayRun(tx, "00000000-0000-4000-8000-000000000000"))).rejects.toThrow(/Payroll is off for this organisation/);
    await as((tx) => updateOrganisationSettings(tx, { payrollEnabled: true }));
  });

  let bookless = "";
  it("PAO3, PAO7: with Accounting off a pay run is worked out and approved without posting, its costs kept for reports", async () => {
    const before = await journalCount();
    const item = await as((tx) => createPayItem(tx, { idempotencyKey: key("item"), name: "Tool allowance", kind: "allowance" }));
    expect(item.payItem.accountCode).toBeNull();
    const created = await as((tx) => createPayRun(tx, { idempotencyKey: key("run"), payGroupId: group, periodStart: "2026-09-28", payDate: "2026-10-14" }));
    bookless = created.payRun.id;
    const approved = (await as((tx) => approvePayRun(tx, bookless, { idempotencyKey: key("approve") }))).payRun;
    expect(approved).toMatchObject({ status: "approved", inBooks: false, approvalJournalId: null });
    const pay = approved.employees.find((entry) => entry.employeeId === employee)!.pay!;
    // $52,000 a year, fortnightly: $2,000.00 gross, with PAYE, KiwiSaver and ESCT worked out as always.
    expect(pay.gross).toBe("2000.00");
    expect(Number(pay.paye)).toBeGreaterThan(0);
    expect(pay.kiwiSaverEmployee).toBe("70.00");
    expect(await journalCount()).toBe(before);
    const postings = await as((tx) => listPayRunPostings(tx, bookless));
    expect(postings.length).toBeGreaterThan(0);
    expect(postings.every((posting) => posting.journalLineOrder === null)).toBe(true);
    // The payslip and the payday filing details are there as usual.
    expect(await as((tx) => getPayslip(tx, bookless, employee))).toBeTruthy();
    expect(await as((tx) => getPayRunPaydayFiling(tx, bookless))).toBeTruthy();
    const summary = await as((tx) => payrollSummaryReport(tx, { from: "2026-10-01", to: "2026-10-31" }));
    expect(JSON.stringify(summary)).toContain("2000.00");
  });

  it("PAO6, PAO8: no payments are recorded and no reconciliation runs without Accounting; IRD shows what's due", async () => {
    await expect(
      as((tx) => recordWagePayment(tx, bookless, { idempotencyKey: key("wages"), paymentDate: "2026-10-14", amount: "1", bankAccountCode: "090" })),
    ).rejects.toThrow(/Accounting is off/);
    await expect(as((tx) => payrollReconciliation(tx, { from: "2026-10-01", to: "2026-10-31" }))).rejects.toThrow(/Accounting is off/);
    const period = await as((tx) => getIrdPeriod(tx, "2026-10-01"));
    expect(Number(period.totalFromPayRuns)).toBeGreaterThan(0);
  });

  it("PAO4, PAO5: turned on later, earlier pay runs stay history; new ones post; a books-free run voids without a journal", async () => {
    await as((tx) => updateOrganisationSettings(tx, { accountingEnabled: true }));
    const before = await journalCount();
    const earlier = await as((tx) => getPayRun(tx, bookless));
    expect(earlier).toMatchObject({ inBooks: false, approvalJournalId: null });
    const next = await as((tx) => createPayRun(tx, { idempotencyKey: key("run"), payGroupId: group, periodStart: "2026-10-12", payDate: "2026-10-28" }));
    // The allowance made without an account isn't on this run, so it posts.
    const posted = (await as((tx) => approvePayRun(tx, next.payRun.id, { idempotencyKey: key("approve") }))).payRun;
    expect(posted.inBooks).toBe(true);
    expect(posted.approvalJournalId).not.toBeNull();
    expect(await journalCount()).toBe(before + 1);
    const voided = (await as((tx) => voidPayRun(tx, bookless, { idempotencyKey: key("void"), voidDate: "2026-10-30" }))).payRun;
    expect(voided).toMatchObject({ status: "voided", voidJournalId: null });
    expect(await journalCount()).toBe(before + 1);
  });
});
