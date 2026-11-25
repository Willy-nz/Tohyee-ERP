import { afterAll, beforeAll, expect, it } from "vitest";
import * as searchRoute from "@/app/api/saved-searches/[searchId]/route";
import * as emailRoute from "@/app/api/saved-searches/[searchId]/email/route";
import * as exportRoute from "@/app/api/saved-searches/export/route";
import * as homeRoute from "@/app/api/saved-searches/home/route";
import * as searchesRoute from "@/app/api/saved-searches/route";
import * as runRoute from "@/app/api/saved-searches/run/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts } from "@/lib/bank/accounts";
import { createBankTransaction } from "@/lib/bank/transactions";
import { createContact } from "@/lib/contacts/service";
import { createCustomField } from "@/lib/custom-fields/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { type OutgoingEmail, setEmailSenderForTests, updateEmailSettings } from "@/lib/email/mailer";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { getOrganisation } from "@/lib/organisations/registry";
import { sendOrganisationSearchEmails } from "@/lib/saved-searches/emails";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { loadRecordTypes } from "@/lib/saved-searches/org-catalogue";
import { type HomeSearch, runSearch, type SavedSearch, saveSavedSearch, type SearchResult } from "@/lib/saved-searches/service";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
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

  const sent: OutgoingEmail[] = [];
  const originalKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "saved-searches-test-key-0123456789abcdef";
    server = await startTestServer();
    setEmailSenderForTests(async (message) => {
      sent.push(message);
    });
    owner = await createTestUser("ss-jade@example.com", { serverAdmin: true });
    aroha = await createTestUser("ss-aroha@example.com");
    viewer = await createTestUser("ss-viewer@example.com");
    await updateEmailSettings({ user: { id: owner.id, email: owner.email, isServerAdmin: true } }, { host: "smtp.example.com", port: 465, username: "books@example.com", password: "app-password" });
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
    setEmailSenderForTests(null);
    process.env.TOHYEE_SECRET_KEY = originalKey;
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

  it("a person whose role isn't known gets the least: they can't share a search with everyone or change someone else's", async () => {
    const roleless = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: viewer.id, email: viewer.email }, work);
    await expect(roleless((tx) => saveSavedSearch(tx, { recordType: "invoice", name: "Everyone's", shared: true, definition: {} }))).rejects.toThrow(/bookkeepers and above/);
    const theirs = await inOrganisation(org, { userId: aroha.id, email: aroha.email, role: "bookkeeper" }, (tx) =>
      saveSavedSearch(tx, { recordType: "bill", name: "Shared by a bookkeeper", shared: true, definition: {} }),
    );
    await expect(roleless((tx) => saveSavedSearch(tx, { id: theirs.id, name: "Taken over", definition: {} }))).rejects.toThrow(/Only the person who made/);
    // With the real role (here an admin) it's allowed, as on the screens.
    await inOrganisation(org, { userId: owner.id, email: owner.email, role: "owner" }, (tx) => saveSavedSearch(tx, { id: theirs.id, name: "Tidied", shared: true, definition: {} }));
    await inOrganisation(org, { userId: owner.id, email: owner.email, role: "owner" }, (tx) => tx.query("delete from saved_searches where id = $1", [theirs.id]));
  });

  it("searches contacts, items and money spent, and by this organisation's own tracking and custom fields", async () => {
    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const department = (await as((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "department")!.id;
    const value = async (name: string) => (await as((tx) => createTrackingValue(tx, { categoryId: department, name }))).categories.find((category) => category.id === department)!.values.find((each) => each.name === name)!.id;
    const farm = await value("Farm");
    const shop = await value("Shop");
    const fields = await as((tx) => createCustomField(tx, { record: "document", label: "Reference", type: "text", usedOn: ["invoice"] }));
    const poField = fields.fields.find((field) => field.label === "Reference")!.id;
    const listFields = await as((tx) => createCustomField(tx, { record: "document", label: "Channel", type: "list", usedOn: ["invoice"], options: ["Market", "Online"] }));
    const channel = listFields.fields.find((field) => field.label === "Channel")!;
    const online = channel.options.find((option) => option.name === "Online")!.id;

    const types = await as((tx) => loadRecordTypes(tx));
    const invoiceFields = types.find((type) => type.key === "invoice")!.fields;
    // A custom field named like a built-in one says so; tracking on a document is "on any line".
    expect(invoiceFields.filter((field) => field.key.startsWith("cf_") || field.key.startsWith("tr_")).map((field) => [field.key, field.label, field.type])).toEqual([
      [`cf_${poField}`, "Reference (custom)", "text"],
      [`cf_${channel.id}`, "Channel", "choice"],
      [`tr_${department}`, "Department (on any line)", "choice"],
    ]);
    expect(types.find((type) => type.key === "journal_line")!.fields.some((field) => field.key === `tr_${department}` && field.label === "Department")).toBe(true);

    const customer = (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Market Stall", email: "stall@example.nz", isCustomer: true }))).contact;
    const made = (
      await as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("invoice"),
          contactId: customer.id,
          invoiceDate: "2026-11-21",
          dueDate: "2026-12-05",
          amountsMode: "exclusive",
          customFields: { [poField]: "PO-77", [channel.id]: online },
          lines: [
            { description: "Milk", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST", tracking: { [department]: farm } },
            { description: "Cheese", quantity: "1", unitPrice: "50.00", accountCode: "4000", taxCode: "GST", tracking: { [department]: shop } },
          ],
        }),
      )
    ).invoice;
    await as((tx) => approveInvoice(tx, made.id, { idempotencyKey: key("approve") }));

    const byShop = await run("invoice", { filters: [{ field: `tr_${department}`, op: "is", value: shop }], columns: ["contact", `tr_${department}`, `cf_${poField}`, `cf_${channel.id}`, "total"] });
    expect(byShop.rows.map((row) => row.cells)).toEqual([["Market Stall", "Farm, Shop", "PO-77", online, "172.50"]]);
    expect(byShop.columns[3].choices).toEqual({ [channel.options[0].id]: "Market", [online]: "Online" });
    // "Isn't" means no line has it: the three untracked invoices.
    expect((await run("invoice", { filters: [{ field: `tr_${department}`, op: "is_not", value: shop }] })).matches).toBe(3);
    expect((await run("invoice", { filters: [{ field: `cf_${channel.id}`, op: "is", value: online }, { field: `cf_${poField}`, op: "starts", value: "po-" }] })).matches).toBe(1);
    await expect(run("invoice", { filters: [{ field: `tr_${department}`, op: "is", value: "999999" }] })).rejects.toThrow(/isn't one of its choices/);
    // On a ledger line the tracking is the line's own.
    const lines = await run("journal_line", { filters: [{ field: `tr_${department}`, op: "is", value: farm }], columns: ["description", "credit", `tr_${department}`] });
    // An invoice's ledger lines are described by its customer.
    expect(lines.rows.map((row) => row.cells)).toEqual([["Market Stall", "100.00", farm]]);
    expect(lines.columns[2].choices).toMatchObject({ [farm]: "Farm" });

    // Contacts: customers and suppliers, not people who are only sales prospects.
    await as((tx) => tx.query("insert into contacts (command_source, idempotency_key, request_hash, name, is_customer, is_supplier, is_prospect) values ('test', $1, 'x', 'Maybe Later Ltd', false, false, true)", [key("contact")]));
    const contacts = await run("contact", { filters: [{ field: "customer", op: "is", value: "true" }], columns: ["name", "email"], sort: { field: "name", direction: "asc" } });
    expect(contacts.rows.map((row) => row.cells[0])).toEqual(["Coast Farm 100%", "Hill Station", "Market Stall"]);
    expect((await run("contact", { filters: [{ field: "name", op: "contains", value: "maybe" }] })).matches).toBe(0);
    expect((await run("contact", { filters: [{ field: "email", op: "not_empty" }] })).rows.map((row) => row.cells[0])).toEqual(["Market Stall"]);

    const bank = (await as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const supplier = (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Fuel Co", isSupplier: true }))).contact;
    await as((tx) => createBankTransaction(tx, { idempotencyKey: key("spend"), kind: "spend", accountId: bank.id, contactId: supplier.id, date: "2026-11-22", amountsMode: "inclusive", lines: [{ description: "Diesel", accountCode: "6000", taxCode: "GST", amount: "115.00", tracking: { [department]: farm } }] }));
    const spent = await run("bank_transaction", { filters: [{ field: "kind", op: "is", value: "spend" }, { field: `tr_${department}`, op: "is", value: farm }], columns: ["date", "contact", "total", "kind"] });
    expect(spent.rows.map((row) => row.cells)).toEqual([["2026-11-22", "Fuel Co", "115.00", "spend"]]);
    expect(spent.rows[0].href).toMatch(/^\/operations\/bank-transactions\/\d+$/);
    expect(spent.totals).toEqual([null, null, "115.00", null]);

    // Items: none in a new organisation, and the search still runs.
    expect(await run("item", { filters: [{ field: "type", op: "is", value: "stock" }] })).toMatchObject({ matches: 0, rows: [] });
  });

  it("shows on Home, and emails each person their own choice, run as them", async () => {
    const cookies = { owner: await sessionCookieFor(owner), aroha: await sessionCookieFor(aroha), viewer: await sessionCookieFor(viewer) };
    const save = async (who: keyof typeof cookies, body: Record<string, unknown>) => {
      const response = await searchesRoute.POST(apiRequest("/api/saved-searches", { method: "POST", cookie: cookies[who], body: { organisationId: org, ...body } }), noContext);
      return ((await response.json()) as { search: SavedSearch }).search;
    };
    const home = async (who: keyof typeof cookies) => ((await (await homeRoute.GET(apiRequest(`/api/saved-searches/home?organisationId=${org}`, { cookie: cookies[who] }), noContext)).json()) as { searches: HomeSearch[] }).searches;
    const email = (who: keyof typeof cookies, searchId: string, body: Record<string, unknown>) =>
      emailRoute.PUT(apiRequest(`/api/saved-searches/${searchId}/email`, { method: "PUT", cookie: cookies[who], body: { organisationId: org, ...body } }), { params: Promise.resolve({ searchId }) });

    const unpaid = await save("aroha", { recordType: "invoice", name: "Unpaid invoices", shared: true, onHome: true, definition: { filters: [{ field: "owing", op: "gt", value: "0" }], columns: ["number", "contact", "owing"], sort: { field: "owing", direction: "desc" } } });
    const mine = await save("viewer", { recordType: "bill", name: "My bills", onHome: true, definition: {} });
    expect(unpaid.onHome).toBe(true);
    // A shared one is on everyone's Home; a private one only on its maker's.
    expect(await home("owner")).toEqual([{ id: unpaid.id, name: "Unpaid invoices", recordLabel: "Invoices", matches: 3, total: "1552.50", totalLabel: "Still owing" }]);
    expect((await home("viewer")).map((search) => search.name)).toEqual(["My bills", "Unpaid invoices"]);

    // Each person sets their own email; nobody can set one on a search they can't open.
    expect((await email("viewer", unpaid.id, { frequency: "daily", onlyWhen: "new_rows" })).status).toBe(200);
    expect((await email("owner", unpaid.id, { frequency: "weekly" })).status).toBe(200);
    expect((await email("aroha", mine.id, { frequency: "daily" })).status).toBe(404);
    expect((await email("viewer", unpaid.id, { frequency: "hourly" })).status).toBe(400);
    const listed = ((await (await searchesRoute.GET(apiRequest(`/api/saved-searches?organisationId=${org}`, { cookie: cookies.viewer }), noContext)).json()) as { searches: SavedSearch[] }).searches;
    expect(listed.find((search) => search.id === unpaid.id)!.myEmail).toEqual({ frequency: "daily", onlyWhen: "new_rows" });

    const record = (await getOrganisation(org))!;
    sent.length = 0;
    // Tuesday 24 November: both are due the first time.
    expect(await sendOrganisationSearchEmails(record, "2026-11-24")).toBe(2);
    expect(sent.map((message) => [message.to, message.subject]).sort()).toEqual([
      [owner.email, "Tohyee: Unpaid invoices: 3 found"],
      [viewer.email, "Tohyee: Unpaid invoices: 3 found"],
    ]);
    expect(sent.find((message) => message.to === viewer.email)!.text).toContain("(3 new)");
    expect(sent[0].text).toContain("Hill Station | 1,150.00");
    // The same day again: nothing. The next day: the viewer's has nothing new, and the owner's weekly one isn't due.
    sent.length = 0;
    expect(await sendOrganisationSearchEmails(record, "2026-11-24")).toBe(0);
    expect(await sendOrganisationSearchEmails(record, "2026-11-25")).toBe(0);
    // A new unpaid invoice: the viewer hears the next day; the owner on Monday.
    const hill = (await as((tx) => tx.query<{ id: string }>("select id::text from contacts where name = 'Hill Station'"))).rows[0].id;
    const made = (await as((tx) => createInvoice(tx, { idempotencyKey: key("invoice"), contactId: hill, invoiceDate: "2026-11-25", dueDate: "2026-12-20", amountsMode: "exclusive", lines: [{ description: "Silage", quantity: "1", unitPrice: "300.00", accountCode: "4000", taxCode: "GST" }] }))).invoice;
    await as((tx) => approveInvoice(tx, made.id, { idempotencyKey: key("approve") }));
    expect(await sendOrganisationSearchEmails(record, "2026-11-26")).toBe(1);
    expect(sent.map((message) => [message.to, message.subject])).toEqual([[viewer.email, "Tohyee: Unpaid invoices: 4 found"]]);
    expect(sent[0].text).toContain("(1 new)");
    sent.length = 0;
    expect(await sendOrganisationSearchEmails(record, "2026-11-30")).toBe(1);
    expect(sent[0].to).toBe(owner.email);

    // Made private again, it stops going to anyone but its maker; someone who has left stops getting theirs.
    await save("aroha", { id: unpaid.id, name: "Unpaid invoices", shared: false, definition: unpaid.definition });
    expect(await home("owner")).toEqual([]);
    await email("viewer", mine.id, { frequency: "daily" });
    await coreQuery("delete from organisation_members where organisation_id = $1 and user_id = $2", [org, viewer.id]);
    sent.length = 0;
    expect(await sendOrganisationSearchEmails(record, "2026-12-07")).toBe(0);
    expect((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from saved_search_emails"))).rows[0].n).toBe("0");
  });

  it("uses the customer's own fields on an invoice, fields holding several choices, and calculated columns", async () => {
    const made = await as((tx) => createCustomField(tx, { record: "contact", label: "Markets", type: "multi_select", usedOn: ["customer"], options: ["Otago", "Southland", "Canterbury"] }));
    const markets = made.fields.find((field) => field.label === "Markets")!;
    const option = (name: string) => markets.options.find((each) => each.name === name)!.id;
    const customer = (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Two Markets Ltd", email: "two@example.nz", isCustomer: true, customFields: { [markets.id]: [option("Southland"), option("Otago")] } }))).contact;
    const invoice = (await as((tx) => createInvoice(tx, { idempotencyKey: key("invoice"), contactId: customer.id, invoiceDate: "2026-11-23", dueDate: "2026-12-20", amountsMode: "exclusive", lines: [{ description: "Wool", quantity: "1", unitPrice: "400.00", accountCode: "4000", taxCode: "GST" }] }))).invoice;
    await as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));

    const types = await as((tx) => loadRecordTypes(tx));
    const invoices = types.find((type) => type.key === "invoice")!;
    expect(invoices.fields.find((field) => field.key === `cc_${markets.id}`)).toMatchObject({ label: "Customer: Markets", type: "choice" });
    expect(types.find((type) => type.key === "contact")!.fields.find((field) => field.key === `cf_${markets.id}`)).toMatchObject({ label: "Markets", type: "choice" });
    expect(types.find((type) => type.key === "bill")!.fields.some((field) => field.key === `cc_${markets.id}`)).toBe(false);

    // "Is" asks whether the choice is among them; the column lists them all, in the field's own order.
    const south = await run("invoice", { filters: [{ field: `cc_${markets.id}`, op: "is", value: option("Southland") }], columns: ["contact", "contactEmail", `cc_${markets.id}`] });
    expect(south.rows.map((row) => row.cells)).toEqual([["Two Markets Ltd", "two@example.nz", "Otago, Southland"]]);
    expect((await run("invoice", { filters: [{ field: `cc_${markets.id}`, op: "is", value: option("Canterbury") }] })).matches).toBe(0);
    expect((await run("contact", { filters: [{ field: `cf_${markets.id}`, op: "is", value: option("Otago") }] })).rows.map((row) => row.cells[0])).toEqual(["Two Markets Ltd"]);
    const others = (await run("invoice", {})).matches - 1;
    expect((await run("invoice", { filters: [{ field: `cc_${markets.id}`, op: "is_not", value: option("Otago") }] })).matches).toBe(others);

    // What the list's search box looks in, in one field.
    expect((await run("invoice", { filters: [{ field: "anyText", op: "contains", value: "two markets" }] })).matches).toBe(1);
    expect((await run("journal_line", { filters: [{ field: "accountClass", op: "is", value: "revenue" }, { field: "description", op: "contains", value: "Two Markets" }], columns: ["credit"] })).rows.map((row) => row.cells)).toEqual([["400.00"]]);

    // Calculated columns: shown, totalled like any number isn't, filtered and sorted.
    const sums = await run("invoice", {
      formulas: [
        { key: "f1", label: "GST part", expression: "{total} - {total} / 1.15" },
        { key: "f2", label: "Share owing", expression: "{owing} / ({total} - {total}) " },
      ],
      filters: [{ field: "f1", op: "gt", value: "50" }],
      columns: ["reference", "total", "f1", "f2"],
      sort: { field: "f1", direction: "asc" },
    });
    // Dividing by nothing leaves the cell empty.
    expect(sums.rows.map((row) => row.cells)).toEqual([
      [null, "460.00", "60.00", null],
      ["Quote stage", "575.00", "75.00", null],
      ["Grazing", "1150.00", "150.00", null],
    ]);
    expect(sums.columns[2]).toMatchObject({ key: "f1", label: "GST part", type: "number" });
    await expect(run("invoice", { formulas: [{ key: "f1", label: "Bad", expression: "{total}); delete from invoices; --" }] })).rejects.toThrow(/isn't something a sum can use/);

    // A saved search keeps its calculated columns.
    const response = await searchesRoute.POST(apiRequest("/api/saved-searches", { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: org, recordType: "invoice", name: "GST parts", definition: { formulas: [{ key: "f1", label: "GST part", expression: "{total} - {total} / 1.15" }], columns: ["number", "f1"] } } }), noContext);
    const saved = ((await response.json()) as { search: SavedSearch }).search;
    expect(saved.definition.formulas).toEqual([{ key: "f1", label: "GST part", expression: "{total} - {total} / 1.15" }]);
    expect(saved.definition.columns).toEqual(["number", "f1"]);
  });
});
