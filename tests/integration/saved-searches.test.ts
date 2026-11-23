import { afterAll, beforeAll, expect, it } from "vitest";
import * as searchRoute from "@/app/api/saved-searches/[searchId]/route";
import * as exportRoute from "@/app/api/saved-searches/export/route";
import * as searchesRoute from "@/app/api/saved-searches/route";
import * as runRoute from "@/app/api/saved-searches/run/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { runSearch, type SavedSearch, type SearchResult } from "@/lib/saved-searches/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;

/** Saved searches read the live books through a fixed list of fields; a search is private until it's shared. */
describeWithDatabase("saved searches", () => {
  let server: TestServer;
  let owner: SessionUser;
  let aroha: SessionUser;
  let viewer: SessionUser;
  const org = "saved-searches-co";
  const numbers: Record<string, string> = {};
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const run = (recordType: string, definition: unknown) => as((tx) => runSearch(tx, { recordType, definition, today: "2026-11-24" }));

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("ss-jade@example.com", { serverAdmin: true });
    aroha = await createTestUser("ss-aroha@example.com");
    viewer = await createTestUser("ss-viewer@example.com");
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [aroha, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const hill = (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Hill Station", isCustomer: true }))).contact;
    const coast = (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Coast Farm 100%", isCustomer: true }))).contact;
    const invoice = async (label: string, contactId: string, invoiceDate: string, dueDate: string, unitPrice: string, approve: boolean) => {
      const made = (await as((tx) => createInvoice(tx, { idempotencyKey: key("invoice"), contactId, invoiceDate, dueDate, reference: label, amountsMode: "exclusive", lines: [{ description: label, quantity: "1", unitPrice, accountCode: "4000", taxCode: "GST" }] }))).invoice;
      numbers[label] = approve ? (await as((tx) => approveInvoice(tx, made.id, { idempotencyKey: key("approve") }))).invoice.invoiceNumber! : "";
    };
    await invoice("Grazing", hill.id, "2026-10-01", "2026-10-20", "1000.00", true);
    await invoice("Hay", coast.id, "2026-11-10", "2026-11-30", "200.00", true);
    await invoice("Quote stage", hill.id, "2026-11-20", "2026-12-20", "500.00", false);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("filters, sorts and totals invoices from the live books", async () => {
    const overdue = await run("invoice", {
      filters: [
        { field: "status", op: "is", value: "approved" },
        { field: "daysOverdue", op: "gt", value: "0" },
      ],
      columns: ["number", "contact", "owing", "daysOverdue", "status"],
    });
    expect(overdue.matches).toBe(1);
    // Due 20 October, looked at on 24 November.
    expect(overdue.rows.map((row) => row.cells)).toEqual([[numbers.Grazing, "Hill Station", "1150.00", "35", "approved"]]);
    expect(overdue.rows[0].href).toMatch(/^\/operations\/invoices\/\d+$/);
    expect(overdue.totals).toEqual([null, null, "1150.00", null, null]);
    expect(overdue.columns[4].choices).toMatchObject({ approved: "Approved" });

    const all = await run("invoice", { columns: ["contact", "reference", "total"], sort: { field: "total", direction: "asc" } });
    expect(all.rows.map((row) => row.cells)).toEqual([
      ["Coast Farm 100%", "Hay", "230.00"],
      ["Hill Station", "Quote stage", "575.00"],
      ["Hill Station", "Grazing", "1150.00"],
    ]);
    expect(all.totals).toEqual([null, null, "1955.00"]);

    const thisMonth = await run("invoice", { filters: [{ field: "date", op: "within", value: "this_month" }, { field: "contact", op: "starts", value: "hill" }], columns: ["reference"] });
    expect(thisMonth.rows.map((row) => row.cells[0])).toEqual(["Quote stage"]);
    // What's typed is looked for as typed: a % is a per cent sign, not "anything".
    expect((await run("invoice", { filters: [{ field: "contact", op: "contains", value: "100%" }] })).matches).toBe(1);
    expect((await run("invoice", { filters: [{ field: "contact", op: "contains", value: "S%n" }] })).matches).toBe(0);
    await expect(run("invoice", { filters: [{ field: "secret", op: "is", value: "x" }] })).rejects.toThrow(/have no field/);
    await expect(run("payslip", {})).rejects.toThrow(/Choose what to search/);
  });

  it("searches ledger lines, and pages", async () => {
    const sales = await run("journal_line", { filters: [{ field: "accountCode", op: "is", value: "4000" }], columns: ["date", "account", "credit", "origin"], sort: { field: "date", direction: "asc" } });
    expect(sales.rows.map((row) => row.cells)).toEqual([
      ["2026-10-01", "Sales", "1000.00", "invoice"],
      ["2026-11-10", "Sales", "200.00", "invoice"],
    ]);
    expect(sales.totals).toEqual([null, null, "1200.00", null]);
    expect(sales.rows[0].href).toMatch(/^\/operations\/ledger-journals\?journal=\d+$/);
    const firstPage = await as((tx) => runSearch(tx, { recordType: "journal_line", definition: {}, limit: 4 }));
    expect(firstPage.rows).toHaveLength(4);
    expect(firstPage.matches).toBe(6);
    expect(firstPage.nextOffset).toBe(4);
    const second = await as((tx) => runSearch(tx, { recordType: "journal_line", definition: {}, limit: 4, offset: 4 }));
    expect(second.rows).toHaveLength(2);
    expect(second.nextOffset).toBeNull();
  });

  it("a search is its maker's until it's shared, and only its maker or an admin changes a shared one", async () => {
    const cookies = { owner: await sessionCookieFor(owner), aroha: await sessionCookieFor(aroha), viewer: await sessionCookieFor(viewer) };
    const save = (who: keyof typeof cookies, body: Record<string, unknown>) => searchesRoute.POST(apiRequest("/api/saved-searches", { method: "POST", cookie: cookies[who], body: { organisationId: org, ...body } }), noContext);
    const list = async (who: keyof typeof cookies) => {
      const response = await searchesRoute.GET(apiRequest(`/api/saved-searches?organisationId=${org}`, { cookie: cookies[who] }), noContext);
      return ((await response.json()) as { searches: SavedSearch[] }).searches;
    };
    const remove = (who: keyof typeof cookies, searchId: string) =>
      searchRoute.DELETE(apiRequest(`/api/saved-searches/${searchId}?organisationId=${org}`, { method: "DELETE", cookie: cookies[who] }), { params: Promise.resolve({ searchId }) });
    const definition = { filters: [{ field: "owing", op: "gt", value: "0" }], columns: ["number", "contact", "owing"] };

    const mineResponse = await save("viewer", { recordType: "invoice", name: "My unpaid", definition });
    expect(mineResponse.status).toBe(201);
    const mine = ((await mineResponse.json()) as { search: SavedSearch }).search;
    expect(mine).toMatchObject({ name: "My unpaid", shared: false, mine: true, canEdit: true, recordLabel: "Invoices" });
    expect(mine.definition.filters).toEqual([{ field: "owing", op: "gt", value: "0.00" }]);
    // Nobody else sees it, not even to delete it.
    expect(await list("aroha")).toEqual([]);
    expect((await remove("aroha", mine.id)).status).toBe(404);
    // A viewer can't share with everyone; a bookkeeper can.
    expect((await save("viewer", { id: mine.id, name: "My unpaid", definition, shared: true })).status).toBe(403);
    expect((await save("viewer", { recordType: "invoice", name: "Bad", definition: { filters: [{ field: "nope", op: "is", value: "1" }] } })).status).toBe(400);
    const sharedResponse = await save("aroha", { recordType: "bill", name: "Bills to pay", shared: true, definition: {} });
    const shared = ((await sharedResponse.json()) as { search: SavedSearch }).search;
    expect((await list("viewer")).map((search) => [search.name, search.mine, search.canEdit])).toEqual([
      ["Bills to pay", false, false],
      ["My unpaid", true, true],
    ]);
    expect((await save("viewer", { id: shared.id, name: "Mine now", definition: {} })).status).toBe(403);
    expect((await remove("viewer", shared.id)).status).toBe(403);
    // An admin can tidy a shared one; its kind of record stays.
    const renamed = await save("owner", { id: shared.id, recordType: "invoice", name: "Bills to pay this week", shared: true, definition: {} });
    expect(((await renamed.json()) as { search: SavedSearch }).search).toMatchObject({ name: "Bills to pay this week", recordType: "bill", mine: false, canEdit: true });

    // Running and downloading.
    const ran = await runRoute.POST(apiRequest("/api/saved-searches/run", { method: "POST", cookie: cookies.viewer, body: { organisationId: org, recordType: "invoice", definition: mine.definition } }), noContext);
    expect(((await ran.json()) as { result: SearchResult }).result.matches).toBe(2);
    const file = await exportRoute.POST(
      apiRequest("/api/saved-searches/export", { method: "POST", cookie: cookies.viewer, body: { organisationId: org, recordType: "invoice", name: "My unpaid!", definition: { columns: ["reference", "status", "total"], sort: { field: "total", direction: "asc" } } } }),
      noContext,
    );
    expect(file.headers.get("content-disposition")).toBe('attachment; filename="my-unpaid.csv"');
    expect(await file.text()).toBe("Reference,Status,Total\r\nHay,Approved,230.00\r\nQuote stage,Draft,575.00\r\nGrazing,Approved,1150.00\r\n");

    expect((await remove("viewer", mine.id)).status).toBe(200);
    expect((await remove("owner", shared.id)).status).toBe(200);
    expect(await list("owner")).toEqual([]);
  });
});
