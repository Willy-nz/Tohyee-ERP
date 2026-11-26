import { afterAll, beforeAll, expect, it } from "vitest";
import * as optionRoute from "@/app/api/income-tax/provisional-option/route";
import { findAiTool } from "@/lib/ai/catalogue";
import type { ToolContext } from "@/lib/ai/tools";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { addProvisionalEstimate, getProvisionalOption, removeProvisionalEstimate, setProvisionalOption } from "@/lib/tax/income/provisional-option-store";
import { addPayment, buildIncomeTax, getIncomeTaxSettings, getIncomeTaxYear, saveIncomeTaxYear, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;

/** Provisional tax options other than standard (TXF14-TXF18; following common practice, not yet reviewed). */
describeWithDatabase("income tax: provisional tax options", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const org = "harakeke-provisional";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const option = (incomeYear: number) => as((tx) => getProvisionalOption(tx, incomeYear));
  const report = async (today: string) => {
    const built = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today }));
    if (!built.supported) throw new Error("not supported");
    return built;
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("provisional-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("provisional-bookkeeper@example.com");
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: false, version: settings.version }));
    await as((tx) => updateOrganisationSettings(tx, { gstPeriodMonths: 2, gstPeriodEndMonth: 3 }));
    await as((tx) => tx.query("update organisation_settings set gst_basis = 'invoice', gst_registered = true, gst_registered_from = null, gst_registered_until = null where id = true"));
    const year = await as((tx) => getIncomeTaxYear(tx, 2026));
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, assessedRit: "20000", returnFiledOn: "2026-06-20", version: year.version }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("TXF14: standard until another option is chosen; only owners and admins change it", async () => {
    expect(await option(2027)).toMatchObject({ option: "standard", ratioPercent: null, estimates: [], version: 0 });
    const standard = await report("2026-07-01");
    expect(standard.provisional.kind === "schedule" && standard.provisional.instalments.map((entry) => entry.amount)).toEqual(["7000.00", "7000.00", "7000.00"]);
    const cookie = await sessionCookieFor(bookkeeper);
    const refused = await optionRoute.PUT(apiRequest("/api/income-tax/provisional-option", { method: "PUT", cookie, body: { organisationId: org, incomeYear: 2027, option: "aim", version: 0 } }), noContext);
    expect(refused.status).toBe(403);
    await expect(as((tx) => setProvisionalOption(tx, { incomeYear: 2027, option: "guess", version: 0 }))).rejects.toThrow("option");
  });

  it("TXF15, TXF18: the estimation option's instalments, interest rules and the AI's figures", async () => {
    await expect(as((tx) => addProvisionalEstimate(tx, { idempotencyKey: key("est"), incomeYear: 2027, estimatedOn: "2026-08-01", amount: "30000" }))).rejects.toThrow("Choose the estimation option");
    await as((tx) => setProvisionalOption(tx, { incomeYear: 2027, option: "estimation", version: 0 }));
    const first = await as((tx) => addProvisionalEstimate(tx, { idempotencyKey: key("est"), incomeYear: 2027, estimatedOn: "2026-08-01", amount: "30000" }));
    await as((tx) => addProvisionalEstimate(tx, { idempotencyKey: key("est"), incomeYear: 2027, estimatedOn: "2027-01-10", amount: "60000" }));
    await expect(as((tx) => addProvisionalEstimate(tx, { idempotencyKey: key("est"), incomeYear: 2027, estimatedOn: "2027-05-08", amount: "1" }))).rejects.toThrow("up to the last instalment date, 7 May 2027");
    const built = await report("2027-01-12");
    expect(built.provisionalOption.option).toBe("estimation");
    expect(built.provisional.kind === "schedule" && built.provisional.instalments.map((entry) => [entry.dueDate, entry.amount])).toEqual([
      ["2026-08-28", "10000.00"],
      ["2027-01-15", "30000.00"],
      ["2027-05-07", "20000.00"],
    ]);
    expect(built.dueDates.filter((entry) => entry.key.startsWith("instalment")).map((entry) => entry.amount)).toEqual(["10000.00", "30000.00", "20000.00"]);
    expect(built.notes.join(" ")).toContain("there's no $60,000 rule");
    expect(built.interest.option).toBe("estimation");

    // The AI sees the option with its estimates (TXF18).
    const context: ToolContext = { role: "owner", organisationId: org, source: "ai-1", accessLevel: "full", grantedAccessLevel: "full" };
    const answer = (await inOrganisation(org, { userId: owner.id, email: owner.email, via: 'AI key "Claude"' }, (tx) => findAiTool("get_income_tax_figures")!.run(tx, { incomeYear: 2027 }, context))) as {
      provisionalOption: { option: string; estimates: Array<{ amount: string }> };
    };
    expect(answer.provisionalOption.option).toBe("estimation");
    expect(answer.provisionalOption.estimates.map((entry) => entry.amount)).toEqual(["30000.00", "60000.00"]);

    await as((tx) => removeProvisionalEstimate(tx, first.estimate.id));
    expect((await option(2027)).estimates).toHaveLength(1);
  });

  it("TXF16: the ratio option's eligibility, and each instalment from the GST return's Box 5", async () => {
    const version = (await option(2027)).version;
    await expect(as((tx) => setProvisionalOption(tx, { incomeYear: 2027, option: "ratio", version }))).rejects.toThrow("Type the ratio IRD gave you");
    await expect(as((tx) => setProvisionalOption(tx, { incomeYear: 2027, option: "ratio", ratioPercent: "100", version }))).rejects.toThrow("less than 100%");
    // Six-monthly GST: refused.
    await as((tx) => updateOrganisationSettings(tx, { gstPeriodMonths: 6, gstPeriodEndMonth: 3 }));
    await expect(as((tx) => setProvisionalOption(tx, { incomeYear: 2027, option: "ratio", ratioPercent: "8", version }))).rejects.toThrow("monthly or two-monthly");
    await as((tx) => updateOrganisationSettings(tx, { gstPeriodMonths: 2, gstPeriodEndMonth: 3 }));
    // Not registered for all of last year: refused.
    await as((tx) => tx.query("update organisation_settings set gst_registered_from = '2025-06-01' where id = true"));
    await expect(as((tx) => setProvisionalOption(tx, { incomeYear: 2027, option: "ratio", ratioPercent: "8", version }))).rejects.toThrow("whole of the 2026 income year");
    await as((tx) => tx.query("update organisation_settings set gst_registered_from = null where id = true"));
    // Last year's RIT over 150,000.00: refused.
    const year = await as((tx) => getIncomeTaxYear(tx, 2026));
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, assessedRit: "160000", returnFiledOn: "2026-06-20", version: year.version }));
    await expect(as((tx) => setProvisionalOption(tx, { incomeYear: 2027, option: "ratio", ratioPercent: "8", version }))).rejects.toThrow("160,000.00");
    const again = await as((tx) => getIncomeTaxYear(tx, 2026));
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, assessedRit: "20000", returnFiledOn: "2026-06-20", version: again.version }));
    const chosen = await as((tx) => setProvisionalOption(tx, { incomeYear: 2027, option: "ratio", ratioPercent: "8", version }));
    expect(chosen).toMatchObject({ option: "ratio", ratioPercent: "8.0000" });

    // Sales of 13,000.00 including GST in May 2026: Box 5 for April and May, worked out from the books.
    const customer = (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Example Customer", isCustomer: true }))).contact;
    await as(async (tx) => {
      const drafted = await createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: customer.id,
        invoiceDate: "2026-05-10",
        dueDate: "2026-06-20",
        amountsMode: "inclusive",
        lines: [{ description: "Joinery", quantity: "1", unitPrice: "13000.00", accountCode: "4000", taxCode: "GST" }],
      });
      await approveInvoice(tx, drafted.invoice.id, { idempotencyKey: key("approve") });
    });
    await as((tx) => addPayment(tx, { idempotencyKey: key("pay"), incomeYear: 2027, paidOn: "2026-06-29", amount: "1040.00" }));
    const built = await report("2026-08-10");
    expect(built.provisional.kind).toBe("schedule");
    if (built.provisional.kind !== "schedule") return;
    expect(built.provisional.instalments).toHaveLength(6);
    expect(built.provisional.instalments[0]).toMatchObject({ dueDate: "2026-06-28", amount: "1040.00", onTimeBy: { date: "2026-06-29" } });
    expect(built.provisional.instalments[0].basis).toContain("8% × 13,000.00");
    // June and July have ended with no sales; August and September haven't.
    expect(built.provisional.instalments[1]).toMatchObject({ dueDate: "2026-08-28", amount: "0.00" });
    expect(built.provisional.instalments[2]).toMatchObject({ dueDate: "2026-10-28", notKnownYet: true });
    expect(built.dueDates.find((entry) => entry.key === "instalment-3")?.amount).toBeNull();
    // Interest only after the end-of-year date.
    expect(built.notes.join(" ")).toContain("only on what's unpaid after the end-of-year tax date");
    expect(built.interest.soFar.amount).toBe("0.00");
  });

  it("TXF17: AIM through other software shows no instalments and no interest estimate", async () => {
    const version = (await option(2027)).version;
    await as((tx) => setProvisionalOption(tx, { incomeYear: 2027, option: "aim", version }));
    const built = await report("2026-08-10");
    expect(built.provisional.kind).toBe("other_software");
    expect(built.provisional.notes[0]).toContain("Your AIM software works out these instalments; Tohyee doesn't");
    expect(built.dueDates.some((entry) => entry.key.startsWith("instalment"))).toBe(false);
    expect(built.interest).toMatchObject({ option: "aim", ifPaidOnTime: null, soFar: { amount: "0.00" } });
    expect(built.interest.notWorkedOut).toContain("AIM");
    // The next year is standard again unless chosen.
    expect((await option(2028)).option).toBe("standard");
    const audit = await as((tx) => tx.query<{ n: number }>("select count(*)::int as n from audit_events where event_type = 'income_tax.provisional_option_set'"));
    expect(audit.rows[0].n).toBe(3);
  });
});
