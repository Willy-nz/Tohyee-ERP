import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as booksRoute from "@/app/api/analytics/books/route";
import * as placedReportRoute from "@/app/api/analytics/dashboards/[dashboardId]/reports/[tileId]/route";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import { closeAnalytics } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createContact } from "@/lib/contacts/service";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import { approveInvoice, createInvoice, voidInvoice } from "@/lib/invoices/service";
import { createCustomReport, getCustomReport, publishCustomReport, updateCustomReport } from "@/lib/reports/custom";
import { createSalesperson } from "@/lib/salespeople/service";
import type { CustomReportLayout } from "@/lib/reports/custom-layout";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "report-slicer-co";
const noContext = undefined as unknown;

/** Examples APS1-APS6 in docs/ACCOUNTING-EXAMPLES.md: a P&L on an Analytics page follows the page's tracking dropdown. */
describeWithDatabase("a placed profit and loss follows the page's dropdown", () => {
  let server: TestServer;
  let owner: SessionUser;
  let cookie: string;
  let root: string;
  let dashboardId = "";
  const ids: Record<string, string> = {};
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked field by field
  const body = async (response: Response) => ({ status: response.status, data: (await response.json()) as Record<string, any> });

  const read = async (tileId: string, values?: Record<string, string[]>) =>
    body(
      await placedReportRoute.GET(
        apiRequest(`/api/analytics/dashboards/${dashboardId}/reports/${tileId}?organisationId=${ORG}${values ? `&values=${encodeURIComponent(JSON.stringify(values))}` : ""}`, { cookie }),
        params({ dashboardId, tileId }),
      ),
    );
  /** Trading income, operating expenses and net profit in the report's one column. */
  const figures = (data: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the computed blocks
    const rows = (data.figures as any).blocks.flatMap((block: any) => (block.kind === "table" ? block.rows : []));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the computed rows
    const value = (id: string) => String(rows.find((row: any) => row.id === id)?.values?.p0 ?? "missing");
    return [value("revenue"), value("expenses"), value("net_profit")];
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-report-slicer-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("slicer-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    cookie = await sessionCookieFor(owner);
    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true, analyticsEnabled: true }));
    const location = (await as((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "location")!;
    ids.location = location.id;
    const valueId = async (name: string, parentId?: string) => {
      const setup = await as((tx) => createTrackingValue(tx, { categoryId: location.id, name, ...(parentId ? { parentId } : {}) }));
      return setup.categories.find((category) => category.id === location.id)!.values.find((value) => value.name === name)!.id;
    };
    ids.otago = await valueId("Otago");
    ids.dunedin = await valueId("Dunedin", ids.otago);
    ids.canterbury = await valueId("Canterbury");
    const journal = (debit: string, credit: string, amount: string, value?: string) =>
      as((tx) =>
        postJournal(tx, {
          idempotencyKey: key("journal"),
          postingDate: "2026-06-15",
          reference: "APS",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0", ...(value ? { tracking: { [location.id]: value } } : {}) },
            { accountCode: credit, debitAmount: "0", creditAmount: amount, ...(value ? { tracking: { [location.id]: value } } : {}) },
          ],
        }),
      );
    await journal("1000", "4000", "100.00", ids.dunedin);
    await journal("1000", "4000", "50.00", ids.canterbury);
    await journal("6010", "1000", "40.00", ids.otago);
    await journal("6010", "1000", "60.00");
    expect((await booksRoute.POST(apiRequest("/api/analytics/books", { method: "POST", cookie, body: { organisationId: ORG } }), noContext)).status).toBeLessThan(300);

    const draft = (await as((tx) => createCustomReport(tx, { idempotencyKey: key("cr"), base: "profit_and_loss", periodEnd: "2026-06-30", start: "standard" }))).report;
    ids.draft = draft.id;
    const copy = (await as((tx) => createCustomReport(tx, { idempotencyKey: key("cr"), base: "profit_and_loss", periodEnd: "2026-06-30", start: "standard" }))).report;
    ids.published = (await as((tx) => publishCustomReport(tx, copy.id, { idempotencyKey: key("pub") }))).report.id;
    const own = (await as((tx) => createCustomReport(tx, { idempotencyKey: key("cr"), base: "profit_and_loss", periodEnd: "2026-06-30", start: "standard" }))).report;
    await as((tx) => updateCustomReport(tx, own.id, { version: own.version, layout: { ...(own.layout as CustomReportLayout), filter: { categoryId: location.id, valueId: ids.canterbury } } }));
    ids.own = own.id;
    const sheet = (await as((tx) => createCustomReport(tx, { idempotencyKey: key("cr"), base: "balance_sheet", periodEnd: "2026-06-30", start: "standard" }))).report;

    const made = await body(
      await dashboardsRoute.POST(
        apiRequest("/api/analytics/dashboards", {
          method: "POST",
          cookie,
          body: {
            organisationId: ORG,
            name: "Regions",
            settings: {
              slicers: [
                { table: "tohyee_ledger_lines", field: "tracking_location", label: "Location", style: "dropdown" },
                { table: "tohyee_ledger_lines", field: "account_name", label: "Account" },
              ],
            },
            tiles: [
              { id: "pl", title: "Profit and loss", visual: "report", report: { id: draft.id } },
              { id: "pl-published", title: "Published", visual: "report", report: { id: ids.published } },
              { id: "pl-own", title: "Canterbury only", visual: "report", report: { id: own.id } },
              { id: "bs", title: "Balance sheet", visual: "report", report: { id: sheet.id } },
            ],
          },
        }),
        noContext,
      ),
    );
    expect(made.status).toBe(201);
    dashboardId = String(made.data.dashboard.id);
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("APS1-APS4: nothing chosen, one value with those under it, a child value, and two values", async () => {
    const none = await read("pl");
    expect(none.status).toBe(200);
    expect(none.data.slicer).toBeNull();
    expect(figures(none.data)).toEqual(["150.00", "100.00", "50.00"]);

    const otago = await read("pl", { tracking_location: ["Otago"] });
    expect(otago.data.slicer).toEqual({ label: "Location: Otago", applied: true, why: null, others: [] });
    expect(figures(otago.data)).toEqual(["100.00", "40.00", "60.00"]);
    expect(otago.data.figures.filterLabel).toBe("Location: Otago");

    expect(figures((await read("pl", { tracking_location: ["Dunedin"] })).data)).toEqual(["100.00", "0.00", "100.00"]);
    expect(figures((await read("pl", { tracking_location: ["Canterbury"] })).data)).toEqual(["50.00", "0.00", "50.00"]);
    const both = await read("pl", { tracking_location: ["Otago", "Canterbury"] });
    expect(both.data.slicer.label).toBe("Location: Otago, Canterbury");
    expect(figures(both.data)).toEqual(["150.00", "40.00", "110.00"]);
  });

  it("APS5: the books and the saved report don't change", async () => {
    await read("pl", { tracking_location: ["Otago"] });
    const saved = await as((tx) => getCustomReport(tx, ids.draft));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the computed figures
    expect(figures({ figures: saved.figures as any })).toEqual(["150.00", "100.00", "50.00"]);
    expect((saved.report.layout as CustomReportLayout).filter ?? null).toBeNull();
  });

  it("APS6: not applied to a published report, one filtered in Reports, or a balance sheet; other columns and fields aren't tracking", async () => {
    const published = await read("pl-published", { tracking_location: ["Otago"] });
    expect(published.data.slicer).toMatchObject({ applied: false, why: "published" });
    expect(figures(published.data)).toEqual(["150.00", "100.00", "50.00"]);
    const own = await read("pl-own", { tracking_location: ["Otago"] });
    expect(own.data.slicer).toMatchObject({ applied: false, why: "own_filter" });
    expect(figures(own.data)).toEqual(["50.00", "0.00", "50.00"]);
    expect((await read("bs", { tracking_location: ["Otago"] })).data.slicer).toMatchObject({ applied: false, why: "kind" });
    // A slicer that isn't on tracking, and a field that isn't one of the report's slicers, do nothing.
    expect((await read("pl", { account_name: ["Sales"] })).data.slicer).toBeNull();
    expect((await read("pl", { tracking_department: ["Retail"] })).data.slicer).toBeNull();
    // Not JSON: ignored, not an error.
    const broken = await body(
      await placedReportRoute.GET(apiRequest(`/api/analytics/dashboards/${dashboardId}/reports/pl?organisationId=${ORG}&values=%7Bnot`, { cookie }), params({ dashboardId, tileId: "pl" })),
    );
    expect(broken.status).toBe(200);
    expect(broken.data.slicer).toBeNull();
  });

  it("APS6: a dropdown that's not on the tile's page doesn't filter it", async () => {
    const current = (await body(await dashboardRoute.GET(apiRequest(`/api/analytics/dashboards/${dashboardId}?organisationId=${ORG}`, { cookie }), params({ dashboardId })))).data.dashboard;
    const settings = {
      ...current.settings,
      pages: [
        { id: "p1", name: "One" },
        { id: "p2", name: "Two" },
      ],
      slicers: [{ ...current.settings.slicers[0], pages: ["p2"] }, current.settings.slicers[1]],
    };
    const patched = await body(
      await dashboardRoute.PATCH(
        apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie, body: { organisationId: ORG, expectedVersion: current.version, settings, tiles: current.tiles } }),
        params({ dashboardId }),
      ),
    );
    expect(patched.status).toBe(200);
    expect((await read("pl", { tracking_location: ["Otago"] })).data.slicer).toBeNull();
  });
});

/** Examples APS7-APS10: a P&L on an Analytics page follows a salesperson dropdown. */
describeWithDatabase("a placed profit and loss follows a salesperson dropdown", () => {
  const SALES_ORG = "report-salesperson-co";
  let server: TestServer;
  let owner: SessionUser;
  let cookie: string;
  let root: string;
  let dashboardId = "";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(SALES_ORG, { userId: owner.id, email: owner.email }, work);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked field by field
  const body = async (response: Response) => ({ status: response.status, data: (await response.json()) as Record<string, any> });
  const read = async (tileId: string, values?: Record<string, string[]>) =>
    body(
      await placedReportRoute.GET(
        apiRequest(`/api/analytics/dashboards/${dashboardId}/reports/${tileId}?organisationId=${SALES_ORG}${values ? `&values=${encodeURIComponent(JSON.stringify(values))}` : ""}`, { cookie }),
        params({ dashboardId, tileId }),
      ),
    );
  const figures = (data: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the computed blocks
    const rows = (data.figures as any).blocks.flatMap((block: any) => (block.kind === "table" ? block.rows : []));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the computed rows
    const value = (id: string) => String(rows.find((row: any) => row.id === id)?.values?.p0 ?? "missing");
    return [value("revenue"), value("expenses"), value("net_profit")];
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tohyee-report-salesperson-"));
    process.env.TOHYEE_ANALYTICS_DIR = path.join(root, "data");
    server = await startTestServer();
    owner = await createTestUser("salesperson-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, SALES_ORG);
    cookie = await sessionCookieFor(owner);
    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true, analyticsEnabled: true }));
    await as((tx) => createSalesperson(tx, { name: "Aroha" }));
    const people = (await as((tx) => createSalesperson(tx, { name: "Ben" }))).salespeople;
    const aroha = people.find((person) => person.name === "Aroha")!.id;
    const ben = people.find((person) => person.name === "Ben")!.id;
    const koru = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Koru Ltd", isCustomer: true, defaultSalespersonId: aroha }))).contact;
    const rata = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Rata Ltd", isCustomer: true }))).contact;
    const line = (amount: string) => ({ description: "Item", quantity: "1", unitPrice: amount, accountCode: "4000", taxCode: "GST" });
    const invoice = async (contactId: string, amount: string, extra: Record<string, unknown> = {}) =>
      (await as((tx) => createInvoice(tx, { idempotencyKey: key("invoice"), contactId, invoiceDate: "2026-06-10", dueDate: "2026-07-31", amountsMode: "exclusive", lines: [line(amount)], ...extra }))).invoice;
    const approve = (id: string) => as((tx) => approveInvoice(tx, id, { idempotencyKey: key("approve") }));
    const one = await invoice(koru.id, "100.00");
    await approve(one.id);
    const two = await invoice(koru.id, "200.00", { salespersonId: ben });
    await approve(two.id);
    const three = await invoice(rata.id, "50.00");
    await approve(three.id);
    const credit = (
      await as((tx) => createCreditNote(tx, { idempotencyKey: key("cn"), contactId: koru.id, creditNoteDate: "2026-06-20", amountsMode: "exclusive", lines: [line("20.00")], salespersonId: aroha }))
    ).creditNote;
    await as((tx) => approveCreditNote(tx, credit.id, { idempotencyKey: key("approve") }));
    await invoice(koru.id, "999.00", { salespersonId: ben });
    await as((tx) => voidInvoice(tx, two.id, { idempotencyKey: key("void"), voidDate: "2026-07-05" }));
    await as((tx) =>
      postJournal(tx, {
        idempotencyKey: key("journal"),
        postingDate: "2026-06-15",
        reference: "Rent",
        lines: [
          { accountCode: "6010", debitAmount: "60.00", creditAmount: "0" },
          { accountCode: "1000", debitAmount: "0", creditAmount: "60.00" },
        ],
      }),
    );
    expect((await booksRoute.POST(apiRequest("/api/analytics/books", { method: "POST", cookie, body: { organisationId: SALES_ORG } }), noContext)).status).toBeLessThan(300);
    const june = (await as((tx) => createCustomReport(tx, { idempotencyKey: key("cr"), base: "profit_and_loss", periodEnd: "2026-06-30", start: "standard" }))).report;
    const july = (await as((tx) => createCustomReport(tx, { idempotencyKey: key("cr"), base: "profit_and_loss", periodEnd: "2026-07-31", start: "standard" }))).report;
    const made = await body(
      await dashboardsRoute.POST(
        apiRequest("/api/analytics/dashboards", {
          method: "POST",
          cookie,
          body: {
            organisationId: SALES_ORG,
            name: "Salespeople",
            settings: { slicers: [{ table: "tohyee_ledger_lines", field: "salesperson", label: "Salesperson", style: "dropdown" }] },
            tiles: [
              { id: "june", title: "June", visual: "report", report: { id: june.id } },
              { id: "july", title: "July", visual: "report", report: { id: july.id } },
            ],
          },
        }),
        noContext,
      ),
    );
    expect(made.status).toBe(201);
    dashboardId = String(made.data.dashboard.id);
  });

  afterAll(async () => {
    await closeAnalytics(SALES_ORG);
    await server?.teardown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("APS7-APS8: one salesperson's sales less credit notes; others' sales and costs with no salesperson are left out", async () => {
    expect(figures((await read("june")).data)).toEqual(["330.00", "60.00", "270.00"]);
    const aroha = await read("june", { salesperson: ["Aroha"] });
    expect(aroha.data.slicer).toEqual({ label: "Salesperson: Aroha", applied: true, why: null, others: [] });
    expect(figures(aroha.data)).toEqual(["80.00", "0.00", "80.00"]);
    expect(figures((await read("june", { salesperson: ["Ben"] })).data)).toEqual(["200.00", "0.00", "200.00"]);
    expect(figures((await read("june", { salesperson: ["Aroha", "Ben"] })).data)).toEqual(["280.00", "0.00", "280.00"]);
  });

  it("APS9: a voided invoice comes off in the month it was voided", async () => {
    expect(figures((await read("july", { salesperson: ["Ben"] })).data)).toEqual(["-200.00", "0.00", "-200.00"]);
    expect(figures((await read("july", { salesperson: ["Aroha"] })).data)).toEqual(["0.00", "0.00", "0.00"]);
  });

  it("APS10: a name that isn't a salesperson shows nothing, not everything", async () => {
    expect(figures((await read("june", { salesperson: ["Nobody"] })).data)).toEqual(["0.00", "0.00", "0.00"]);
  });
});
