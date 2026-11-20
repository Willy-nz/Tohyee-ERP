import { afterAll, beforeAll, expect, it } from "vitest";
import * as structureRoute from "@/app/api/organisations/[organisationId]/business-structure/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { directoryPage, getOrganisationDirectory } from "@/lib/organisations/directory";
import { getBusinessStructure, saveBusinessStructure } from "@/lib/organisations/entity";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { getPaydayFilingSettings } from "@/lib/payroll/payday-filing-service";
import { draftNotes } from "@/lib/reports/financial-statements";
import { getIncomeTaxSettings, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/** Business structure (ENT1-ENT8, following common practice, not yet reviewed). A made-up organisation. */
describeWithDatabase("business structure", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const org = "ruru-orchards";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email, role: "owner" }, work);
  const notes = async () => Object.fromEntries((await as((tx) => draftNotes(tx))).map((note) => [note.title, note.body]));

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("structure-owner@example.com");
    bookkeeper = await createTestUser("structure-bookkeeper@example.com");
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [org, bookkeeper.id]);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("ENT1, ENT2: starts blank; owners and admins set the type and a checked IRD number", async () => {
    expect(await as((tx) => getBusinessStructure(tx))).toEqual({ entityType: null, irdNumber: null });
    const put = (who: SessionUser, body: Record<string, unknown>) =>
      sessionCookieFor(who).then((cookie) =>
        structureRoute.PUT(apiRequest(`/api/organisations/${org}/business-structure`, { method: "PUT", cookie, body }), { params: Promise.resolve({ organisationId: org }) }),
      );
    expect((await put(bookkeeper, { entityType: "company" })).status).toBe(403);
    const refused = await put(owner, { entityType: "company", irdNumber: "49-091-851" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "That IRD number doesn't pass Inland Revenue's check. Check the digits." });
    expect((await put(owner, { entityType: "cooperative" })).status).toBe(400);
    const saved = await put(owner, { entityType: "company", irdNumber: "49-091-850" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ structure: { entityType: "company", irdNumber: "049091850" } });
    expect(await as((tx) => getOrganisationSettings(tx))).toMatchObject({ entityType: "company", irdNumber: "049091850" });
  });

  it("ENT3: income tax follows a company or sole trader, and can't be set against it", async () => {
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    expect(settings).toMatchObject({ taxpayerType: "company", entityType: "company", unsupported: null });
    await expect(as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "individual", agentExtension: false, version: settings.version }))).rejects.toThrow(
      "Settings › Business structure says this is a company, so the taxpayer is company. Change it there.",
    );
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: true, version: settings.version }));

    await as((tx) => saveBusinessStructure(tx, { entityType: "sole_trader", irdNumber: "49-091-850" }));
    expect(await as((tx) => getIncomeTaxSettings(tx))).toMatchObject({ taxpayerType: "individual", agentExtension: true });

    await as((tx) => saveBusinessStructure(tx, { entityType: "partnership", irdNumber: "49-091-850" }));
    const partnership = await as((tx) => getIncomeTaxSettings(tx));
    expect(partnership.unsupported).toBe("Tohyee's income tax is for companies and sole traders. A partnership's partners are taxed on their shares.");
    await expect(as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "company", agentExtension: false, version: partnership.version }))).rejects.toThrow(
      "A partnership's partners are taxed on their shares.",
    );
  });

  it("ENT4-ENT6: the draft year-end notes follow the type", async () => {
    await as((tx) => saveBusinessStructure(tx, { entityType: "company", irdNumber: null }));
    const company = await notes();
    expect(company["Reporting entity"]).toContain("is a company registered under the Companies Act 1993.");
    expect(company["Basis of preparation"]).toContain("They meet the minimum requirements of the Tax Administration (Financial Statements) Order 2014.");
    expect(company["Basis of preparation"]).not.toContain("Domestic Trusts");
    expect(company).toHaveProperty("Transactions with associated persons");
    expect(company).toHaveProperty("Shareholders' equity and current accounts");

    await as((tx) => saveBusinessStructure(tx, { entityType: "trust", irdNumber: null }));
    const trust = await notes();
    expect(trust["Basis of preparation"]).toContain("Domestic Trusts) Order 2022.");
    expect(trust).toHaveProperty("Trust capital and beneficiaries' current accounts");
    expect(trust).toHaveProperty("Related parties");

    await as((tx) => saveBusinessStructure(tx, { entityType: "look_through_company", irdNumber: null }));
    const ltc = await notes();
    expect(ltc["Income tax"]).toContain("As a look-through company, the company isn't taxed on its income.");
    expect(ltc["Basis of preparation"]).not.toContain("Order 20");

    await as((tx) => saveBusinessStructure(tx, { entityType: "sole_trader", irdNumber: null }));
    const soleTrader = await notes();
    expect(soleTrader["Income tax"]).toContain("Income tax paid from the business's accounts is shown as drawings.");
    expect(soleTrader).toHaveProperty("Owner's equity");

    await as((tx) => saveBusinessStructure(tx, { entityType: "incorporated_society", irdNumber: null }));
    expect(await notes()).toHaveProperty("Accumulated funds");
  });

  it("ENT7: the directory page shows what it is and its IRD number", async () => {
    await as((tx) => saveBusinessStructure(tx, { entityType: "trust", irdNumber: "49098576" }));
    const page = await as(async (tx) => directoryPage(await getOrganisationSettings(tx), await getOrganisationDirectory(tx)));
    expect(page.sections[0].lines).toEqual(expect.arrayContaining([{ label: "Entity type", value: "Trust" }, { label: "IRD number", value: "49-098-576" }]));
  });

  it("ENT8: payday filing starts from the organisation's IRD number", async () => {
    expect((await as((tx) => getPaydayFilingSettings(tx))).employerIrdNumber).toBe("049098576");
  });
});
