import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { saveAiDashboard } from "@/lib/ai-workspace/dashboards";
import { addAiFile } from "@/lib/ai-workspace/files";
import { addPaddock, listFarms, saveFarm } from "@/lib/farming/paddocks";
import { createAnimal } from "@/lib/farming/animals";
import { startSharing, updatePosition } from "@/lib/farming/locations";
import { createMob } from "@/lib/farming/mobs";
import { FARM_STAFF_READ_TOOLS, FARM_STAFF_RECORD_TOOLS } from "@/lib/ai/farm-staff";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { listGrazings } from "@/lib/farming/pasture";
import { addGauge } from "@/lib/farming/rainfall";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setFarmingEnabled } from "@/lib/farming/paddocks";
import { headCount, setOpenings, updateLivestockSettings } from "@/lib/livestock/movements";
import { acceptLivestockSuggestion, declineLivestockSuggestion } from "@/lib/livestock/suggestions";
import { addSystem } from "@/lib/effluent/setup";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { addCamera } from "@/lib/security-cameras/cameras";
import { createEmployee } from "@/lib/payroll/employees";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "ai-farm";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

let rpcId = 0;
async function rpc(token: string, method: string, rpcParams?: unknown) {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: rpcParams }),
    }),
    noContext,
  );
  return (await response.json()) as Json;
}

async function call(token: string, name: string, args: Json = {}): Promise<Json> {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

/** The AI's farm workspace (AIW1-AIW9; not yet reviewed). */
describeWithDatabase("the AI's farm workspace", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const tokens: Record<string, string> = {};
  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  async function makeKey(user: SessionUser, name: string, accessLevel: string) {
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: ORG, name, accessLevel, ...(accessLevel === "full" ? { confirmFullAccess: true } : {}) } }),
      noContext,
    );
    tokens[name] = ((await response.json()) as { token: string }).token;
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    owner = await createTestUser("farm-ai-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    bookkeeper = await createTestUser("farm-ai-bookkeeper@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, bookkeeper.id]);
    await asOwner((tx) =>
      tx.query("insert into payroll_access (user_id, granted_by_user_id, granted_by_email) values ($1, $1, 'test') on conflict do nothing", [owner.id]),
    );
    await asOwner((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    await asOwner((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2025-06-01" }));
    // The farm notebook tools are offered with Farming on.
    await asOwner((tx) => setFarmingEnabled(tx, { enabled: true }));
    await asOwner((tx) => setOpenings(tx, { lines: [{ kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" }] }));
    await makeKey(owner, "owner-drafts", "draft");
    await makeKey(owner, "owner-read", "read");
    await makeKey(bookkeeper, "bookkeeper-drafts", "draft");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("AIW1, AIW2: the AI reads and adds to the farm notebook; a look-only key can't write", async () => {
    const added = await call(tokens["owner-drafts"], "add_farm_note", { category: "goals", title: "Lift production", body: "Aim for 450 kgMS per cow by 2028.", happenedOn: "2026-06-01" });
    expect(added).toMatchObject({ category: "goals", writtenBy: "ai", title: "Lift production" });
    await call(tokens["owner-drafts"], "update_farm_note", { noteId: added.id, category: "goals", title: "Lift production", body: "Aim for 460 kgMS per cow by 2028." });
    const notes = (await call(tokens["owner-read"], "farm_notebook", { search: "kgms" })).notes as Json[];
    expect(notes.map((note) => note.body)).toEqual(["Aim for 460 kgMS per cow by 2028."]);
    await expect(call(tokens["owner-read"], "add_farm_note", { category: "goals", title: "x", body: "y" })).rejects.toThrow();
  });

  it("AIW3-AIW7: files read as text (Excel sheet by sheet), organised into a table, queried exactly and laid out as a dashboard", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Calving 2025");
    sheet.addRow(["Tag", "Calved", "Sex", "Weight kg"]);
    sheet.addRow(["101", new Date(Date.UTC(2025, 7, 1)), "F", 32.5]);
    sheet.addRow(["102", new Date(Date.UTC(2025, 7, 3)), "M", 35.25]);
    sheet.addRow(["103", new Date(Date.UTC(2025, 8, 2)), "F", 30.1]);
    const file = await asOwner(async (tx) => addAiFile(tx, { fileName: "calving.xlsx", contentBase64: Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64"), note: "From the herd app" }));
    await expect(asOwner((tx) => addAiFile(tx, { fileName: "photo.gif", contentBase64: "AAAA" }))).rejects.toThrow(/CSV, TSV, text, JSON and Excel/);
    // A JPG is taken now (PIC5), but only if it really is one.
    await expect(asOwner((tx) => addAiFile(tx, { fileName: "photo.jpg", contentBase64: "AAAA" }))).rejects.toThrow(/doesn't look like a JPG/);
    //: no macro workbooks, and a workbook is checked before it's opened.
    const plain = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(asOwner((tx) => addAiFile(tx, { fileName: "calving.xlsm", contentBase64: plain.toString("base64") }))).rejects.toThrow(/CSV, TSV, text, JSON and Excel/);
    const bomb = await JSZip.loadAsync(plain);
    bomb.file("xl/media/zeros.bin", Buffer.alloc(20 * 1024 * 1024));
    const bombBytes = await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
    await expect(asOwner((tx) => addAiFile(tx, { fileName: "bomb.xlsx", contentBase64: bombBytes.toString("base64") }))).rejects.toThrow(/unsafe|limit/);
    const listed = (await call(tokens["owner-read"], "list_ai_uploads")).files as Json[];
    expect(listed.map((entry) => entry.fileName)).toEqual(["calving.xlsx"]);
    const read = await call(tokens["owner-read"], "read_ai_upload", { fileId: file.id });
    expect(read.text).toBe("## Sheet: Calving 2025\nTag,Calved,Sex,Weight kg\n101,2025-08-01,F,32.5\n102,2025-08-03,M,35.25\n103,2025-09-02,F,30.1");

    await call(tokens["owner-drafts"], "save_dataset", {
      name: "calvings",
      description: "Calves born, from calving.xlsx",
      columns: [
        { name: "tag", type: "text" },
        { name: "calved_on", type: "date" },
        { name: "sex", type: "text" },
        { name: "weight_kg", type: "number" },
      ],
    });
    await expect(call(tokens["owner-drafts"], "add_dataset_rows", { name: "calvings", rows: [{ tag: "104", calved_on: "1 Aug", sex: "F", weight_kg: "31" }] })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(call(tokens["owner-drafts"], "add_dataset_rows", { name: "calvings", rows: [{ tag: "104", colour: "red" }] })).rejects.toThrow(/isn't a column/);
    await call(tokens["owner-drafts"], "add_dataset_rows", {
      name: "calvings",
      rows: [
        { tag: "101", calved_on: "2025-08-01", sex: "F", weight_kg: "32.5" },
        { tag: "102", calved_on: "2025-08-03", sex: "M", weight_kg: 35.25 },
        { tag: "103", calved_on: "2025-09-02", sex: "F", weight_kg: "30.1" },
      ],
    });
    // 0.1 + 0.2 style sums stay exact: 32.5 + 35.25 + 30.1 = 97.85.
    const totals = await call(tokens["owner-read"], "query_dataset", {
      name: "calvings",
      groupBy: [{ field: "calved_on", grain: "month" }],
      measures: [{ aggregate: "count", label: "calves" }, { aggregate: "sum", field: "weight_kg", label: "kg" }],
    });
    expect(totals.rows).toEqual([
      { calved_on: "2025-08", calves: "2", kg: "67.75" },
      { calved_on: "2025-09", calves: "1", kg: "30.1" },
    ]);
    const heifers = await call(tokens["owner-read"], "query_dataset", { name: "calvings", filters: [{ field: "sex", op: "eq", value: "F" }, { field: "weight_kg", op: "gt", value: "31" }] });
    expect(heifers.rows).toEqual([{ tag: "101", calved_on: "2025-08-01", sex: "F", weight_kg: "32.5" }]);
    const all = await call(tokens["owner-read"], "query_dataset", { name: "calvings", measures: [{ aggregate: "sum", field: "weight_kg", label: "kg" }] });
    expect(all.rows).toEqual([{ kg: "97.85" }]);

    // AIW7: the older dashboards can't be made by an AI any more; ones already there can still be read.
    await expect(call(tokens["owner-drafts"], "save_ai_dashboard", { name: "Calving", tiles: [{ title: "Total weight", kind: "kpi", dataset: "calvings", measures: [{ aggregate: "sum", field: "weight_kg" }] }] })).rejects.toThrow();
    const older = await asOwner((tx) =>
      saveAiDashboard(tx, {
        name: "Calving",
        tiles: [
          { title: "Calves by month", kind: "column", dataset: "calvings", groupBy: [{ field: "calved_on", grain: "month" }], measures: [{ aggregate: "count", label: "calves" }], width: 2 },
          { title: "Total weight", kind: "kpi", dataset: "calvings", measures: [{ aggregate: "sum", field: "weight_kg", label: "kg" }] },
        ],
      }),
    );
    const dashboard = await call(tokens["owner-read"], "get_ai_dashboard", { dashboardId: older.id });
    expect((dashboard.results as Json[]).map((result) => result.rows)).toEqual([
      [
        { calved_on: "2025-08", calves: "2" },
        { calved_on: "2025-09", calves: "1" },
      ],
      [{ kg: "97.85" }],
    ]);
  });

  it("AIW8: the AI suggests livestock movements; a person accepts (recorded with every check) or declines", async () => {
    const before = await asOwner((tx) => headCount(tx, { yearEnd: "2026-05-31" }));
    expect(before.rows.find((row) => row.classCode === "ma_cows")!.died).toBe(0);
    const suggested = (await call(tokens["owner-drafts"], "suggest_livestock_movements", {
      suggestions: [
        { movement: { movementType: "death", movementDate: "2026-01-20", kind: "dairy_cattle", classCode: "ma_cows", head: 2 }, evidence: "calving.xlsx row 7: two cows died" },
        { movement: { movementType: "sale", movementDate: "2026-03-10", kind: "dairy_cattle", classCode: "ma_cows", head: 40, amount: "44000.00" }, evidence: "Agent's sheet" },
      ],
    })).suggestions as Json[];
    expect(suggested.map((entry) => entry.decision)).toEqual([null, null]);
    // Nothing is recorded until a person accepts.
    expect((await asOwner((tx) => headCount(tx, { yearEnd: "2026-05-31" }))).rows.find((row) => row.classCode === "ma_cows")!.closing).toBe(300);
    const accepted = await asOwner((tx) => acceptLivestockSuggestion(tx, suggested[0].id, { idempotencyKey: key("accept") }));
    expect(accepted.suggestion).toMatchObject({ decision: "accepted", movementId: accepted.movement.id });
    await asOwner((tx) => declineLivestockSuggestion(tx, suggested[1].id));
    await expect(asOwner((tx) => declineLivestockSuggestion(tx, suggested[1].id))).rejects.toThrow(/already declined/);
    const count = (await call(tokens["owner-read"], "livestock_overview", { yearEnd: "2026-05-31" })).headCount as { rows: Json[] };
    expect(count.rows.find((row) => row.classCode === "ma_cows")).toMatchObject({ died: 2, sold: 0, closing: 298 });
    expect(((await call(tokens["owner-read"], "list_livestock_suggestions", { open: true })).suggestions as Json[]).length).toBe(0);
    await expect(call(tokens["owner-drafts"], "suggest_livestock_movements", { suggestions: [{ movement: { movementType: "teleport" }, evidence: "x" }] })).rejects.toThrow(/movementType/);
  });

  it("AIW9: staff with pay only for someone with payroll access; never IRD, bank or birth dates", async () => {
    await asOwner((tx) =>
      createEmployee(tx, {
        idempotencyKey: key("employee"),
        firstName: "Aroha",
        lastName: "Ngata",
        email: "aroha@example.nz",
        phone: "021 555 0123",
        postalAddress: "12 Example Street",
        dateOfBirth: "1990-02-03",
        taxCode: "M",
        irdNumber: "123456789",
        kiwiSaverStatus: "enrolled",
        kiwiSaverEmployeeRate: "4",
        kiwiSaverEmployerRate: "3.5",
        studentLoan: false,
        payFrequency: "fortnightly",
        payBasis: "salary",
        annualSalary: "70000.00",
        hourlyRate: null,
        ordinaryHoursPerWeek: null,
        startDate: "2026-04-01",
        finishDate: null,
        bankAccount: "03-1234-0123456-00",
      }),
    );
    const withPay = await call(tokens["owner-read"], "list_staff");
    expect(withPay.includesPay).toBe(true);
    expect((withPay.staff as Json[])[0]).toMatchObject({ name: "Aroha Ngata", annualSalary: "70000" });
    const text = JSON.stringify(withPay);
    for (const secret of ["123456789", "0123456", "1990-02-03"]) expect(text).not.toContain(secret);
    const noPay = await call(tokens["bookkeeper-drafts"], "list_staff");
    expect(noPay.includesPay).toBe(false);
    expect(noPay.staff).toEqual([{ name: "Aroha Ngata", jobTitle: null, startDate: "2026-04-01", finishDate: null, reportsTo: null, group: null, archived: false }]);
    expect(JSON.stringify(noPay)).not.toContain("70000");
  });

  it("#701: the AI records field work the way the screens do, marked as through the AI; a look-only key can't", async () => {
    const farm = (await asOwner((tx) => saveFarm(tx, { name: "Home Farm" })))[0];
    const paddock = await asOwner((tx) => addPaddock(tx, { farmId: farm.id, name: "Paddock 19", effectiveHa: "4.20", onDate: "2026-07-01" }));
    const gauge = await asOwner((tx) => addGauge(tx, { farmId: farm.id, name: "House gauge" }));

    // "I moved the milkers to paddock 19 this morning and fed 2 bales."
    const grazing = (await call(tokens["bookkeeper-drafts"], "record_grazing", { paddockId: paddock.id, mob: "Milkers", head: 280, inOn: "2026-11-14", preCover: 2900, idempotencyKey: "field-work-0001" })).grazing as Json;
    expect(grazing).toMatchObject({ mob: "Milkers", head: 280, inOn: "2026-11-14", outOn: null });
    const fed = (await call(tokens["bookkeeper-drafts"], "record_supplements_fed", { paddockId: paddock.id, fedOn: "2026-11-14", feed: "Baleage", quantity: "2", unit: "bales", mob: "Milkers" })).supplement as Json;
    expect(fed).toMatchObject({ feed: "Baleage", quantity: "2.00", unit: "bales" });
    // The same call sent again (a lost answer) isn't recorded twice.
    const again = (await call(tokens["bookkeeper-drafts"], "record_grazing", { paddockId: paddock.id, mob: "Milkers", head: 280, inOn: "2026-11-14", preCover: 2900, idempotencyKey: "field-work-0001" })).grazing as Json;
    expect(again.id).toBe(grazing.id);
    // The screen's own rules apply: a paddock holds one mob at a time.
    await expect(call(tokens["bookkeeper-drafts"], "record_grazing", { paddockId: paddock.id, mob: "Heifers", inOn: "2026-11-14" })).rejects.toThrow("already has a mob in it");

    const reading = (await call(tokens["owner-drafts"], "record_pasture_reading", { paddockId: paddock.id, measuredOn: "2026-11-14", cover: 2400, method: "visual", note: "By eye" })).reading as Json;
    expect(reading).toMatchObject({ cover: 2400, method: "visual", source: 'Recorded via AI key "owner-drafts"' });
    const gauges = (await call(tokens["owner-read"], "list_rain_gauges", {})).gauges as Json[];
    expect(gauges.map((entry) => entry.name)).toEqual(["House gauge"]);
    const rain = (await call(tokens["owner-drafts"], "record_rainfall", { gaugeId: gauge.id, readOn: "2026-11-14", mm: "12.5" })).reading as Json;
    expect(rain).toMatchObject({ mm: "12.5" });

    const task = (await call(tokens["owner-drafts"], "add_farm_task", { title: "Check the trough in Paddock 19", dueOn: "2026-11-15", paddockId: paddock.id })).task as Json;
    expect(((await call(tokens["owner-read"], "list_farm_tasks", {})).tasks as Json[]).map((entry) => entry.title)).toEqual(["Check the trough in Paddock 19"]);
    const done = (await call(tokens["owner-drafts"], "mark_farm_task_done", { taskId: task.id, doneFor: "2026-11-15" })).task as Json;
    expect(done.next).toBeNull();
    expect((await call(tokens["owner-read"], "list_farm_tasks", {})).tasks).toEqual([]);

    // : what's on, from tools alone. The Home cards carry the cover just recorded; calendar text is marked as from outside.
    const home = await call(tokens["owner-read"], "farm_home", {});
    expect(Object.keys(home)[0]).toBe("fromOutside");
    expect((home.pasture as Json[])[0]).toMatchObject({ farmName: "Home Farm", averageKgDmPerHa: 2400 });
    // 300 cows at the start, less the 2 deaths accepted in AIW8.
    expect(home.stock).toMatchObject({ total: 298 });
    const calendar = await call(tokens["owner-read"], "farm_calendar", { from: "2026-11-01", to: "2026-11-30" });
    expect(calendar).toMatchObject({ items: [], needsChecking: 0 });
    expect((await call(tokens["owner-read"], "farm_product_stock", {})).products).toEqual([]);

    //: the livestock valuation methods on record.
    expect(await call(tokens["owner-read"], "list_livestock_elections", {})).toMatchObject({ elections: expect.any(Array), more: false });
    //: the Livestock year-end screens.
    const stock = (name: string, args: Json = {}) => call(tokens["owner-read"], name, args);
    expect(await stock("livestock_settings")).toMatchObject({ enabled: true, financialYearEndMonth: expect.any(Number) });
    expect(await stock("list_livestock_openings")).toMatchObject({ openings: expect.any(Array), more: false });
    expect(await stock("list_livestock_locations")).toMatchObject({ locations: expect.any(Array), more: false });
    expect(await stock("list_livestock_rates")).toMatchObject({ rates: expect.any(Array), more: false });
    expect(await stock("list_high_priced_livestock")).toMatchObject({ animals: expect.any(Array), more: false });
    expect(await stock("list_livestock_account_sales")).toMatchObject({ accountSales: expect.any(Array), more: false });
    expect(await stock("list_livestock_management_values")).toMatchObject({ values: expect.any(Array), more: false });
    expect(await stock("livestock_management_report")).toMatchObject({ months: expect.any(Array), missingValues: expect.any(Array) });
    expect(await stock("livestock_ageing_preview")).toMatchObject({ steps: expect.any(Array), needsSplit: expect.any(Array) });
    const valuing = await stock("livestock_valuation_preview");
    expect(valuing).toMatchObject({ journal: expect.any(Array), problems: expect.any(Array) });
    await expect(stock("livestock_valuation_preview", { yearEnd: "2026-01-15" })).rejects.toThrow();
    //: the organisation's directory, as a report's directory page shows it.
    const directory = await call(tokens["owner-read"], "get_organisation_directory", {});
    expect(directory.name).toEqual(expect.any(String));
    expect((directory.sections as Json[])[0]).toMatchObject({ title: "Details" });

    //: more of what the farm screens show.
    expect(await call(tokens["owner-read"], "farm_rotation_plan", {})).toMatchObject({ planned: [], nextByPaddock: {}, nextByMob: {} });
    expect(await call(tokens["owner-read"], "list_breeding_records", {})).toMatchObject({ breeding: [], more: false });
    expect(await call(tokens["owner-read"], "list_tractor_equipment", {})).toMatchObject({ equipment: [], more: false });
    expect(await call(tokens["owner-read"], "list_tractor_jobs", {})).toMatchObject({ jobs: [], more: false });
    const effluent = await call(tokens["owner-read"], "effluent_log", {});
    expect(effluent).toMatchObject({ applications: [], readings: [] });
    expect(effluent).not.toHaveProperty("setup");
    expect(await call(tokens["owner-read"], "effluent_care", {})).toMatchObject({ incidents: [] });
    expect(await call(tokens["owner-read"], "farm_safety", {})).toMatchObject({ hazards: [] });
    const shares = await call(tokens["owner-read"], "coop_share_schedule", {});
    expect(shares).toHaveProperty("holdings");
    expect(await call(tokens["owner-read"], "farm_year_figures", { yearEnd: shares.yearEnd })).toEqual({ figures: [] });
    await expect(call(tokens["owner-read"], "farm_year_figures", { yearEnd: "2026-01-15" })).rejects.toThrow("financial year end");

    // Look only can read the tasks and gauges, never record.
    await expect(call(tokens["owner-read"], "record_pasture_reading", { paddockId: paddock.id, measuredOn: "2026-11-14", cover: 2400, method: "visual" })).rejects.toThrow();
    // What was recorded shows where the screens show it, and the history says who and through what.
    expect((await asOwner((tx) => listGrazings(tx, { farmId: farm.id }))).rows.map((entry) => entry.mob)).toEqual(["Milkers"]);
    const audit = await asOwner((tx) => tx.query<{ actor_email: string; via: string | null }>("select actor_email, details->>'via' as via from audit_events where event_type = 'farming.grazing_added'"));
    expect(audit.rows).toEqual([{ actor_email: bookkeeper.email, via: 'AI key "bookkeeper-drafts"' }]);
  });
  it("#701: the AI records treatments, body condition, weights and soil samples; withholding is never made up", async () => {
    const farm = (await asOwner((tx) => listFarms(tx))).find((entry) => entry.name === "Home Farm")!;
    const paddock = (await asOwner((tx) => addPaddock(tx, { farmId: farm.id, name: "Paddock 7", effectiveHa: "5.00", onDate: "2026-07-01" })));
    const mob = (await asOwner((tx) => createMob(tx, { farmId: farm.id, name: "Springers", kind: "dairy_cattle", classCode: "ma_cows", head: 40, onDate: "2026-09-01" }))).mob;
    const cow = await asOwner((tx) => createAnimal(tx, { farmId: farm.id, kind: "dairy_cattle", tag: "214", sex: "female", mobId: mob.id, onDate: "2026-09-01" }));

    // "Drenched the springers this morning, 10 mL each, label says 35 days meat and nil milk."
    const treated = await call(tokens["bookkeeper-drafts"], "record_animal_treatment", {
      mobId: mob.id,
      treatedOn: "2026-11-14",
      givenTime: "7:30",
      product: "Made-up Drench",
      dose: "10 mL each",
      meatWithholdingDays: 35,
      milkWithholdingHours: 0,
      givenBy: "Sam",
      idempotencyKey: "treatment-0001",
    });
    expect(treated.treatment).toMatchObject({ head: 40, product: "Made-up Drench", meatWithholdingDays: 35, milkWithholdingHours: 0, meatSafeOn: "2026-12-19" });
    expect(treated.message).toContain("safe for slaughter from 2026-12-19");
    // Not told the withholding: it's left as "not entered" and the answer says so. Nothing is guessed.
    const unknown = await call(tokens["bookkeeper-drafts"], "record_animal_treatment", { animals: "214", head: 1, treatedOn: "2026-11-14", product: "Made-up Pour-on", dose: "20 mL", givenBy: "Sam" });
    expect(unknown.treatment).toMatchObject({ meatWithholdingDays: null, milkWithholdingHours: null, meatSafeOn: null });
    expect(unknown.message).toContain("No withholding was entered");
    // The same send again is the same treatment; the screen's rules still apply.
    const again = await call(tokens["bookkeeper-drafts"], "record_animal_treatment", { mobId: mob.id, treatedOn: "2026-11-14", givenTime: "7:30", product: "Made-up Drench", dose: "10 mL each", meatWithholdingDays: 35, milkWithholdingHours: 0, givenBy: "Sam", idempotencyKey: "treatment-0001" });
    expect((again.treatment as Json).id).toBe((treated.treatment as Json).id);
    await expect(call(tokens["bookkeeper-drafts"], "record_animal_treatment", { mobId: mob.id, head: 41, product: "X", dose: "1", givenBy: "Sam" })).rejects.toThrow("40 head");
    expect(((await call(tokens["owner-read"], "list_animal_treatments", {})).treatments as Json[]).map((entry) => entry.product).sort()).toEqual(["Made-up Drench", "Made-up Pour-on"]);

    const scored = await call(tokens["bookkeeper-drafts"], "record_bcs", { mobId: mob.id, onDate: "2026-11-14", tally: { "4.0": 10, "4.5": 20 }, scoredBy: "Sam" });
    expect(scored.record).toMatchObject({ headScored: 30 });
    expect((await call(tokens["bookkeeper-drafts"], "record_bcs", { animalId: cow.id, onDate: "2026-11-14", score: "4.5" })).message).toContain("BCS 4.5 recorded for 214");
    expect((await call(tokens["bookkeeper-drafts"], "record_animal_weight", { animalId: cow.id, onDate: "2026-11-14", kg: "462.5" })).message).toBe("214: 462.5 kg.");
    const sample = (await call(tokens["bookkeeper-drafts"], "record_soil_sample", { paddockId: paddock.id, takenOn: "2026-11-14", sampleName: "P7-A", depth: "75 mm" })).sample as Json;
    expect(sample).toMatchObject({ sampleName: "P7-A" });
    await expect(call(tokens["owner-read"], "record_bcs", { animalId: cow.id, score: "4.0" })).rejects.toThrow();

    //: single records, weather and status.
    const read = (name: string, args: Json = {}) => call(tokens["owner-read"], name, args);
    expect(await read("list_soil_samples", { paddockId: paddock.id })).toMatchObject({ samples: [{ sampleName: "P7-A", paddockName: "Paddock 7" }], more: false });
    expect(await read("paddock_pasture", { paddockId: paddock.id })).toMatchObject({ readings: expect.any(Array), grazings: expect.any(Array) });
    expect(await read("paddock_history", { paddockId: paddock.id })).toMatchObject({ soilTests: [], applications: [] });
    const statuses = (await read("paddock_statuses", { farmId: farm.id })).paddocks as Json[];
    expect(statuses.find((entry) => entry.paddockId === paddock.id)).toMatchObject({ name: "Paddock 7" });
    const one = await read("get_mob", { mobId: mob.id });
    expect(one.mob).toMatchObject({ name: "Springers" });
    expect(one).toHaveProperty("events");
    expect(await read("farm_tasks_due", { from: "2026-11-01", to: "2026-11-30" })).toMatchObject({ items: expect.any(Array), more: false });
    expect(await read("farm_recent_weather", { farmId: farm.id })).toMatchObject({ days: expect.any(Array) });
    expect(await read("farm_weather_forecast", { farmId: farm.id })).toMatchObject({ canRefresh: false });
    // Comparing needs forecast records switched on; until then the tool says so, as the screen does.
    await expect(read("forecast_vs_gauge", { farmId: farm.id })).rejects.toThrow("Enable forecast records");
    //: health and safety, and the camera log without its pictures.
    expect(await read("safety_today", { farmId: farm.id })).toBeTruthy();
    expect(await read("safety_due", { from: "2026-11-01", to: "2026-11-30" })).toMatchObject({ items: expect.any(Array), more: false });
    expect(await read("list_safety_chemicals", { farmId: farm.id })).toMatchObject({ chemicals: expect.any(Array), more: false });
    expect(await read("safety_equipment", { farmId: farm.id })).toMatchObject({ equipment: expect.any(Array), checklists: expect.any(Array) });
    const inductions = await read("safety_inductions", { farmId: farm.id });
    expect(inductions).toMatchObject({ inductions: expect.any(Array), signoffs: expect.any(Array) });
    expect(inductions).not.toHaveProperty("links");
    expect(await read("list_safety_training")).toMatchObject({ training: expect.any(Array), more: false });
    expect(await read("safety_reports", { farmId: farm.id })).toMatchObject({ reports: expect.any(Array), otherActions: expect.any(Array) });
    expect(await read("check_safety_history")).toBeTruthy();
    await expect(read("safety_record_history", { recordId: "999999" })).rejects.toThrow();
    await expect(read("list_safety_equipment_checks", { equipmentId: "999999" })).rejects.toThrow();
    await asOwner((tx) => addCamera(tx, { farmId: farm.id, name: "Shed gate" }));
    const cameras = await read("list_security_cameras");
    expect(cameras).toMatchObject({ cameras: [{ name: "Shed gate", farmName: "Home Farm", eventCount: 0 }], more: false });
    expect(JSON.stringify(cameras)).not.toContain("uploadUsername");
    expect(await read("list_security_camera_events")).toMatchObject({ events: expect.any(Array), more: false, nextCursor: null });
    await expect(read("get_security_camera_event", { eventId: "999999" })).rejects.toThrow();
    //: the overview no longer writes its settings row on first read, so a Look only key can read it.
    expect(((await read("greenness_overview")).farms as Json[]).map((entry) => entry.farmName)).toContain("Home Farm");
    const gauge = ((await read("list_rain_gauges", { farmId: farm.id })).gauges as Json[])[0];
    expect(await read("rain_gauge_summary", { gaugeId: gauge.id })).toMatchObject({ gauge: { id: gauge.id }, months: expect.any(Array), seasons: expect.any(Array) });
    await expect(read("rain_gauge_summary", { gaugeId: "999999" })).rejects.toThrow();
    await expect(read("get_tractor_job", { jobId: "999999" })).rejects.toThrow();
    await expect(read("paddock_pasture", {})).rejects.toThrow();

    //: reporting, set-up and single records.
    expect((await read("get_paddock", { paddockId: paddock.id })).paddock).toMatchObject({ name: "Paddock 7", boundaries: expect.any(Array) });
    expect(await read("effluent_today", { farmId: farm.id })).toBeTruthy();
    expect(await read("effluent_due", { from: "2026-11-01", to: "2026-11-30" })).toMatchObject({ items: expect.any(Array), more: false });
    expect(await read("list_bcs_scales", { farmId: farm.id })).toMatchObject({ scales: expect.any(Array), more: false });
    expect(await read("list_stock_unit_factors")).toMatchObject({ factors: expect.any(Array), more: false });
    expect(await read("list_pasture_photo_estimates", { farmId: farm.id })).toMatchObject({ waiting: expect.any(Array), decided: expect.any(Array), more: false });
    expect(await read("pasture_photo_calibration", { farmId: farm.id })).toBeTruthy();
    expect(await read("list_farm_map_assets", { farmId: farm.id })).toMatchObject({ assets: expect.any(Array), more: false });
    expect(await read("get_farm_water", { farmId: farm.id })).toMatchObject({ water: { pipes: expect.any(Array), counts: expect.any(Object), stock: { classes: expect.any(Array) }, materials: { sizes: expect.any(Array) } } });
    // FW5: 110 L/min over 450 m on the flat suggests 50 mm; FW1 for a pipe of your own.
    expect(await read("size_farm_pipe", { flowLpm: 110, lengthM: 450 })).toMatchObject({ suggestedOutsideMm: 50 });
    // FW7 and FW8.
    expect(await read("stock_water_demand", { stock: [{ class: "dairy_milking", head: 300 }] })).toMatchObject({ litresPerDay: 21000, peakLpm: 70 });
    expect(await read("match_farm_pump", { points: [{ flowLpm: 20, headM: 62 }, { flowLpm: 60, headM: 55 }, { flowLpm: 100, headM: 42 }, { flowLpm: 140, headM: 22 }], insideMm: 40.8, lengthM: 450, riseM: 12, endHeadM: 10, fittingsPct: 0 })).toMatchObject({ match: { kind: "meets", flowLpm: 100, headM: 42 } });
    expect(await read("size_farm_pipe", { flowLpm: 110, lengthM: 450, insideMm: 40.8, fittingsPct: 0 })).toMatchObject({ result: { velocity: 1.4, frictionM: 23.7, totalKpa: 232 } });
    // FW11: a tenth more friction for fittings unless told otherwise.
    expect(await read("size_farm_pipe", { flowLpm: 110, lengthM: 450, insideMm: 40.8 })).toMatchObject({ fittingsPct: 10, result: { velocity: 1.4, frictionM: 26.1 } });
    expect(((await read("farm_team", { farmId: farm.id })).people as Json[]).map((person) => person.role)).toContain("owner");
    expect(await read("farm_terms")).toMatchObject({ terms: expect.any(Object) });
    const farming = await read("farming_settings");
    expect(farming).toMatchObject({ enabled: true, hasImageryKey: false });
    expect(farming).not.toHaveProperty("imageryKey");
    const taskId = (((await read("list_farm_tasks", { farmId: farm.id })).tasks as Json[]) ?? [])[0]?.id;
    if (taskId) expect(await read("farm_task_history", { taskId })).toMatchObject({ history: expect.any(Array), more: false });
    await expect(read("tractor_job_withholding", { jobId: "not-a-job" })).rejects.toThrow();
    expect(await read("farm_comparison")).toMatchObject({ farms: expect.any(Array) });
    expect(await read("farm_reporting_setup")).toMatchObject({ farms: expect.any(Array) });
    expect(await read("list_farm_expense_groups")).toMatchObject({ accounts: expect.any(Array) });
    expect(await read("farm_benchmark_year_figures", { yearEnd: "2026-05-31" })).toMatchObject({ yearEnd: "2026-05-31" });
    expect(await read("farm_benchmarks_by_farm", { yearEnd: "2026-05-31" })).toBeTruthy();
    await expect(read("farm_benchmark_year_figures", { yearEnd: "2026-01-15" })).rejects.toThrow("financial year end");

    //: only those sharing now, only the latest position, and reading changes nothing.
    expect(await read("farm_people_locations", { farmId: farm.id })).toMatchObject({ people: [] });
    const sharing = await asOwner((tx) => startSharing(tx, { farmId: farm.id, hours: 2 }));
    await asOwner((tx) => updatePosition(tx, { shareId: sharing.shareId, latitude: -46.2, longitude: 169.9, accuracyMetres: 8, takenAt: new Date().toISOString() }));
    const there = (await read("farm_people_locations", { farmId: farm.id })).people as Json[];
    expect(there).toHaveLength(1);
    expect(there[0]).toMatchObject({ isMe: true, position: { latitude: -46.2, longitude: 169.9, accuracyMetres: 8 } });
    await asOwner((tx) => tx.query("update farm_location_shares set started_at = now() - interval '3 hours', ends_at = now() - interval '1 minute'"));
    expect(await read("farm_people_locations", { farmId: farm.id })).toMatchObject({ people: [] });
    expect((await asOwner((tx) => tx.query("select 1 from farm_location_shares"))).rowCount).toBe(1);
    await asOwner((tx) => tx.query("delete from farm_location_shares"));

    //: the last reads.
    expect(await read("effluent_setup", { farmId: farm.id })).toMatchObject({ systems: expect.any(Array), ponds: expect.any(Array), blocks: expect.any(Array), consents: expect.any(Array) });
    expect(await read("list_mobs_named_on_grazings", { farmId: farm.id })).toMatchObject({ mobs: expect.any(Array), more: false });
    expect(await read("list_pasture_photos", { farmId: farm.id })).toMatchObject({ photos: expect.any(Array), more: false });
    expect(await read("list_pasture_photos", { paddockId: paddock.id })).toMatchObject({ photos: [], more: false });
    expect((await read("greenness_cover_check", { farmId: farm.id })).check).toMatchObject({ farmName: "Home Farm" });
    expect(await read("list_fertiliser_bill_lines")).toMatchObject({ lines: expect.any(Array), more: false });
    expect(await read("list_mob_linkable_movements", { mobId: mob.id, type: "sale" })).toMatchObject({ movements: expect.any(Array), more: false });
    expect(await read("livestock_rations_year", { yearEnd: "2026-05-31" })).toBeTruthy();

    //: one answer to "what's due on the farm?".
    const due = await read("farm_whats_due", { farmId: farm.id });
    expect(due).toMatchObject({ tasks: expect.any(Array), effluent: expect.any(Array), safety: expect.any(Array), mobsWithheld: expect.any(Array), paddocksNotSafeToGraze: expect.any(Array) });
    expect(Date.parse(String(due.to)) - Date.parse(String(due.from))).toBe(7 * 86_400_000);
    await expect(read("farm_whats_due", { farmId: farm.id, from: "2026-11-10", to: "2026-11-01" })).rejects.toThrow("before the start");

    //: effluent applications. The ponding check is the person's, never made up.
    const irrigator = await asOwner((tx) =>
      addSystem(tx, { farmId: farm.id, name: "Irrigator", type: "travelling_irrigator", settings: { flowM3PerHour: "18", wettedWidthM: "30", speedMPerHour: "40" } }, new Map([[owner.id, "Owner"]])),
    );
    const effluentNow = await read("effluent_log", { farmId: farm.id });
    expect(effluentNow.systems).toEqual([expect.objectContaining({ recordId: irrigator.recordId, name: "Irrigator", type: "travelling_irrigator", available: true })]);
    expect(effluentNow).not.toHaveProperty("setup");
    const draft = (name: string, args: Json) => call(tokens["bookkeeper-drafts"], name, args);
    const started = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const stopped = new Date(Date.now() - 3_600_000).toISOString();
    // Finished without the check is refused, as on the screen.
    await expect(draft("record_effluent_application", { farmId: farm.id, systemId: irrigator.recordId, paddockIds: [paddock.id], startedAt: started, stoppedAt: stopped, idempotencyKey: "effluent-run-0" })).rejects.toThrow("ponding and runoff check");
    await expect(draft("record_effluent_application", { farmId: farm.id, systemId: irrigator.recordId, startedAt: started, idempotencyKey: "effluent-run-0b" })).rejects.toThrow("Say where");
    const run = (await draft("record_effluent_application", { farmId: farm.id, systemId: irrigator.recordId, paddockIds: [paddock.id], startedAt: started, idempotencyKey: "effluent-run-1" })).record as Json;
    expect(run.data).toMatchObject({ systemId: irrigator.recordId, paddockIds: [paddock.id], stoppedAt: null });
    // Sent twice, recorded once.
    expect(((await draft("record_effluent_application", { farmId: farm.id, systemId: irrigator.recordId, paddockIds: [paddock.id], startedAt: started, idempotencyKey: "effluent-run-1" })).record as Json).recordId).toBe(run.recordId);
    const running = ((await read("effluent_log", { farmId: farm.id })).applications as Json[]).filter((entry) => entry.running);
    expect(running.map((entry) => entry.recordId)).toEqual([run.recordId]);
    await expect(draft("stop_effluent_application", { applicationId: run.recordId, version: run.version, stoppedAt: stopped, ponding: { result: "ponding" }, idempotencyKey: "effluent-stop-0" })).rejects.toThrow("what was seen");
    const done = (await draft("stop_effluent_application", { applicationId: run.recordId, version: run.version, stoppedAt: stopped, ponding: { result: "none" }, idempotencyKey: "effluent-stop-1" })).record as Json;
    expect(done.data).toMatchObject({ stoppedAt: expect.any(String), ponding: { result: "none" } });
    expect(((await read("effluent_log", { farmId: farm.id })).applications as Json[]).some((entry) => entry.running)).toBe(false);
    // Look only can't record, and the history says it came through the AI key.
    await expect(read("record_effluent_application", { farmId: farm.id, systemId: irrigator.recordId, paddockIds: [paddock.id], startedAt: started })).rejects.toThrow();
    const via = await asOwner((tx) => tx.query<{ via: string | null }>("select via from safety_entries where record_id = $1 order by version", [run.recordId]));
    expect(via.rows.map((row) => row.via)).toEqual(['AI key "bookkeeper-drafts"', 'AI key "bookkeeper-drafts"']);
  });

  it("#701: Make and post moves and counts a mob, and records births, deaths and livestock movements", async () => {
    await makeKey(bookkeeper, "bookkeeper-posts", "post");
    const post = (name: string, args: Json) => call(tokens["bookkeeper-posts"], name, args);
    const farm = (await asOwner((tx) => listFarms(tx))).find((entry) => entry.name === "Home Farm")!;
    const from = await asOwner((tx) => addPaddock(tx, { farmId: farm.id, name: "Paddock 30", effectiveHa: "3.00", onDate: "2026-07-01" }));
    const to = await asOwner((tx) => addPaddock(tx, { farmId: farm.id, name: "Paddock 31", effectiveHa: "3.00", onDate: "2026-07-01" }));
    const calves = (await asOwner((tx) => createMob(tx, { farmId: farm.id, name: "Calves", kind: "dairy_cattle", classCode: "r1_heifers", head: 20, onDate: "2026-09-01", paddockId: from.id }))).mob;
    const yearEnd = "2027-05-31";
    const heifers = async () => {
      const rows = ((await call(tokens["owner-read"], "livestock_overview", { yearEnd })).headCount as { rows: Json[] }).rows;
      return rows.find((row) => row.classCode === "r1_heifers") ?? {};
    };
    const before = await heifers();

    // Field-work keys can't: this level is what Jade chose for moves and counts.
    await expect(call(tokens["bookkeeper-drafts"], "move_mob", { mobId: calves.id, toPaddockId: to.id })).rejects.toThrow();
    await expect(call(tokens["owner-read"], "record_mob_deaths", { mobId: calves.id, head: 1 })).rejects.toThrow();

    const moved = await post("move_mob", { mobId: calves.id, toPaddockId: to.id, onDate: "2026-11-10", idempotencyKey: "mob-move-0001" });
    expect(moved.message).toBe("Calves moved to Paddock 31.");
    expect((moved.mob as Json).paddock).toMatchObject({ id: to.id });
    // Sent again, it isn't moved twice.
    expect((await post("move_mob", { mobId: calves.id, toPaddockId: to.id, onDate: "2026-11-10", idempotencyKey: "mob-move-0001" })).message).toBe("Already recorded.");
    await expect(post("move_mob", { mobId: calves.id, toPaddockId: to.id, onDate: "2026-11-11", idempotencyKey: "mob-move-0002" })).rejects.toThrow("already in Paddock 31");

    const born = await post("record_mob_births", { mobId: calves.id, head: 5, onDate: "2026-11-11", idempotencyKey: "mob-births-0001" });
    expect(born).toMatchObject({ livestock: "recorded", mob: { head: 25 } });
    const died = await post("record_mob_deaths", { mobId: calves.id, head: 2, onDate: "2026-11-12", idempotencyKey: "mob-deaths-0001" });
    expect(died).toMatchObject({ livestock: "recorded", mob: { head: 23 } });
    await expect(post("record_mob_deaths", { mobId: calves.id, head: 500, idempotencyKey: "mob-deaths-0002" })).rejects.toThrow("23 head");
    // A count changes the mob, not the books.
    const counted = await post("count_mob", { mobId: calves.id, head: 22, onDate: "2026-11-13", idempotencyKey: "mob-count-0001" });
    expect(counted.message).toContain("The books' head count isn't changed by a count");
    expect(counted).toMatchObject({ livestock: "none", mob: { head: 22 } });

    const after = await heifers();
    expect(Number(after.births ?? 0) - Number(before.births ?? 0)).toBe(5);
    expect(Number(after.died ?? 0) - Number(before.died ?? 0)).toBe(2);

    // A movement straight into the books' head count, recorded once.
    const movement = { movementType: "death", movementDate: "2026-11-14", kind: "dairy_cattle", classCode: "ma_cows", head: 1, note: "Found in the creek paddock", idempotencyKey: "livestock-death-0001" };
    const first = await post("record_livestock_movement", movement);
    expect(first).toMatchObject({ created: true, movement: { movementType: "death", head: 1 } });
    expect(await post("record_livestock_movement", movement)).toMatchObject({ created: false });
    await expect(post("record_livestock_movement", { ...movement, head: 100000, idempotencyKey: "livestock-death-0002" })).rejects.toThrow();
    await expect(call(tokens["bookkeeper-drafts"], "record_livestock_movement", { ...movement, idempotencyKey: "livestock-death-0003" })).rejects.toThrow();
    // The history says it came through the AI key.
    const audit = await asOwner((tx) => tx.query<{ via: string | null }>("select details->>'via' as via from audit_events where event_type like 'livestock.movement%' order by id desc limit 1"));
    expect(audit.rows[0]?.via).toBe('AI key "bookkeeper-posts"');

    //: selling, buying, changing class, splitting and merging.
    const sold = await post("sell_from_mob", { mobId: calves.id, head: 3, amount: "1500.00", onDate: "2026-11-15", idempotencyKey: "mob-sell-0001" });
    expect(sold).toMatchObject({ livestock: "recorded", mob: { head: 19 } });
    expect(Number((await heifers()).sold ?? 0) - Number(before.sold ?? 0)).toBe(3);
    const bought = await post("buy_into_mob", { mobId: calves.id, head: 4, amount: "2200.00", onDate: "2026-11-16", idempotencyKey: "mob-buy-0001" });
    expect(bought).toMatchObject({ livestock: "recorded", mob: { head: 23 } });
    const split = await post("split_mob", { mobId: calves.id, head: 8, name: "Small calves", toPaddockId: from.id, onDate: "2026-11-17", idempotencyKey: "mob-split-0001" });
    expect(split).toMatchObject({ livestock: "none", mob: { head: 15 } });
    expect(String(split.message)).toContain("8 split from Calves into Small calves in Paddock 30");
    await expect(post("split_mob", { mobId: calves.id, head: 15, idempotencyKey: "mob-split-0002" })).rejects.toThrow("not all of them");
    const small = ((await call(tokens["owner-read"], "list_mobs", { farmId: farm.id })).mobs as Json[]).find((entry) => entry.name === "Small calves")!;
    const merged = await post("merge_mobs", { mobId: small.id, intoMobId: calves.id, onDate: "2026-11-18", idempotencyKey: "mob-merge-0001" });
    expect(String(merged.message)).toContain("Small calves merged into Calves, which now has 23 head");
    // Calves was added as stock already on the farm, so the books don't hold its head in this class: the books' rule refuses, as on the screen.
    await expect(post("change_mob_class", { mobId: calves.id, toClassCode: "r2_heifers", onDate: "2026-11-19", idempotencyKey: "mob-class-0000" })).rejects.toThrow("below zero");
    const young = (await asOwner((tx) => createMob(tx, { farmId: farm.id, name: "Spring born", kind: "dairy_cattle", classCode: "r1_heifers", head: 6, onDate: "2026-11-01", how: "born" }))).mob;
    const reclassed = await post("change_mob_class", { mobId: young.id, toClassCode: "r2_heifers", onDate: "2026-11-19", idempotencyKey: "mob-class-0001" });
    expect(reclassed).toMatchObject({ livestock: "recorded", mob: { classCode: "r2_heifers" } });
    await expect(call(tokens["bookkeeper-drafts"], "sell_from_mob", { mobId: calves.id, head: 1 })).rejects.toThrow();

    // Full access, after a preview: undo the class change, and void the movement recorded straight into the books.
    await makeKey(owner, "owner-full", "full");
    const full = (name: string, args: Json) => call(tokens["owner-full"], name, args);
    await expect(post("undo_mob_event", { mobId: young.id, eventId: "1", reason: "Wrong class" })).rejects.toThrow();
    const events = (await call(tokens["owner-read"], "get_mob", { mobId: young.id })).events as Json[];
    const classChange = events.find((event) => event.eventType === "reclass")!;
    const preview = await full("undo_mob_event", { mobId: young.id, eventId: classChange.id, reason: "Wrong class", onDate: "2026-11-20" });
    expect(preview).toMatchObject({ preview: true, actsOn: { id: classChange.id, reference: "Spring born: reclass" } });
    expect(((await call(tokens["owner-read"], "list_mobs", { farmId: farm.id })).mobs as Json[]).find((entry) => entry.id === young.id)).toMatchObject({ classCode: "r2_heifers" });
    const undone = await full("undo_mob_event", { mobId: young.id, eventId: classChange.id, reason: "Wrong class", onDate: "2026-11-20", confirmHash: preview.confirmHash, idempotencyKey: "mob-undo-0001" });
    expect(undone).toMatchObject({ livestock: "reversed", mob: { classCode: "r1_heifers" } });
    await expect(full("undo_mob_event", { mobId: young.id, eventId: classChange.id, reason: "Again", confirmHash: "nope" })).rejects.toThrow();

    const movementId = ((first.movement as Json).id) as string;
    const voiding = await full("void_livestock_movement", { movementId, reason: "Recorded twice" });
    expect(voiding).toMatchObject({ preview: true, actsOn: { id: movementId, status: "recorded" } });
    const voided = await full("void_livestock_movement", { movementId, reason: "Recorded twice", confirmHash: voiding.confirmHash, idempotencyKey: "livestock-void-0001" });
    expect((voided.movement as Json).voided).toBe(true);
  });


  it("#703: farm staff can use an AI for field work on their own farms, and for nothing else", async () => {
    const home = (await asOwner((tx) => listFarms(tx))).find((farm) => farm.name === "Home Farm")!;
    const runoff = (await asOwner((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!;
    const paddock12 = await asOwner((tx) => addPaddock(tx, { farmId: home.id, name: "Paddock 12", effectiveHa: "3.10", onDate: "2026-07-01" }));
    const far = await asOwner((tx) => addPaddock(tx, { farmId: runoff.id, name: "Back block", effectiveHa: "9.00", onDate: "2026-07-01" }));
    const staff = await createTestUser("farm-ai-staff@example.com");
    const rep = await createTestUser("farm-ai-rep@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker'), ($1, $3, 'sales_rep')", [ORG, staff.id, rep.id]);
    await asOwner((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "farm_worker", access: "farms", farmIds: [home.id] }));

    // They can make a key that looks or records field work; nothing that posts. A CRM-only person still can't.
    const make = async (user: SessionUser, body: Json) => tokensRoute.POST(apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: ORG, ...body } }), noContext);
    expect((await make(staff, { name: "staff-post", accessLevel: "post" })).status).toBe(403);
    expect((await make(rep, { name: "rep-read" })).status).toBe(403);
    await makeKey(staff, "staff-records", "draft");
    await makeKey(staff, "staff-looks", "read");

    // Only the field-work tools, said in farm words.
    const listed = ((await rpc(tokens["staff-records"], "tools/list")).result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect([...listed].sort()).toEqual([...FARM_STAFF_READ_TOOLS, ...FARM_STAFF_RECORD_TOOLS].sort());
    const looks = ((await rpc(tokens["staff-looks"], "tools/list")).result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect([...looks].sort()).toEqual([...FARM_STAFF_READ_TOOLS].sort());
    const instructions = ((await rpc(tokens["staff-records"], "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).result as Json).instructions as string;
    expect(instructions).toContain("Farm field work for");
    expect(instructions).not.toContain("get_organisation");

    // "Cover in paddock 12 is 2,400": saved under their name, through the AI.
    const reading = (await call(tokens["staff-records"], "record_pasture_reading", { paddockId: paddock12.id, measuredOn: "2026-11-15", cover: 2400, method: "visual" })).reading as Json;
    expect(reading).toMatchObject({ cover: 2400, source: 'Recorded via AI key "staff-records"' });
    const audit = await asOwner((tx) => tx.query<{ actor_email: string }>("select actor_email from audit_events where event_type = 'farming.pasture_reading_added' order by id desc limit 1"));
    expect(audit.rows[0].actor_email).toBe(staff.email);
    await expect(call(tokens["staff-looks"], "record_pasture_reading", { paddockId: paddock12.id, measuredOn: "2026-11-15", cover: 2500, method: "visual" })).rejects.toThrow();

    // Their farms only: the other farm isn't listed and can't be read or recorded on.
    const farms = (await call(tokens["staff-records"], "list_farms_and_paddocks")).farms as Json[];
    expect(farms.map((farm) => farm.name)).toEqual(["Home Farm"]);
    await expect(call(tokens["staff-records"], "record_pasture_reading", { paddockId: far.id, measuredOn: "2026-11-15", cover: 2000, method: "visual" })).rejects.toThrow("not found");
    await expect(call(tokens["staff-records"], "list_pasture_readings", { farmId: runoff.id })).rejects.toThrow("not found");

    //: the four later record tools too, on their own farms only.
    const sample = (await call(tokens["staff-records"], "record_soil_sample", { paddockId: paddock12.id, takenOn: "2026-11-15", sampleName: "P12-A" })).sample as Json;
    expect(sample).toMatchObject({ sampleName: "P12-A" });
    await expect(call(tokens["staff-records"], "record_soil_sample", { paddockId: far.id, takenOn: "2026-11-15", sampleName: "BB-A" })).rejects.toThrow("not found");
    const farMob = (await asOwner((tx) => createMob(tx, { farmId: runoff.id, name: "Heifers away", kind: "dairy_cattle", classCode: "ma_cows", head: 10, onDate: "2026-09-01" }))).mob;
    const farCow = await asOwner((tx) => createAnimal(tx, { farmId: runoff.id, kind: "dairy_cattle", tag: "901", sex: "female", mobId: farMob.id, onDate: "2026-09-01" }));
    await expect(call(tokens["staff-records"], "record_animal_weight", { animalId: farCow.id, onDate: "2026-11-15", kg: "410" })).rejects.toThrow("not found");
    await expect(call(tokens["staff-records"], "record_bcs", { animalId: farCow.id, score: "4.5" })).rejects.toThrow("not found");
    await expect(call(tokens["staff-looks"], "record_soil_sample", { paddockId: paddock12.id, takenOn: "2026-11-15", sampleName: "P12-B" })).rejects.toThrow();

    //: farm staff read the round, tractor jobs, effluent and safety on their own farms, never another farm's or the business's.
    expect(await call(tokens["staff-looks"], "farm_safety", { farmId: home.id })).toMatchObject({ hazards: [] });
    expect(await call(tokens["staff-looks"], "farm_rotation_plan", { farmId: home.id })).toMatchObject({ planned: [] });
    await expect(call(tokens["staff-looks"], "farm_safety", { farmId: runoff.id })).rejects.toThrow();
    await expect(call(tokens["staff-looks"], "list_tractor_jobs", { farmId: runoff.id })).rejects.toThrow();
    await expect(call(tokens["staff-looks"], "effluent_log", { farmId: runoff.id })).rejects.toThrow();
    await expect(call(tokens["staff-looks"], "coop_share_schedule", {})).rejects.toThrow();
    await expect(call(tokens["staff-looks"], "get_organisation_directory", {})).rejects.toThrow();
    await expect(call(tokens["staff-looks"], "farm_year_figures", { yearEnd: "2026-05-31" })).rejects.toThrow();

    //: a breeding record on their own farm's mob, never another farm's; a pond that isn't there is refused.
    const homeMob = (await asOwner((tx) => createMob(tx, { farmId: home.id, name: "Staff test herd", kind: "dairy_cattle", classCode: "ma_cows", head: 40, onDate: "2026-09-01" }))).mob;
    const tested = (await call(tokens["staff-records"], "record_breeding", { mobId: homeMob.id, recordType: "pregnancy_test", onDate: "2026-11-10", head: 40, inCalf: 36, idempotencyKey: "staff-preg-test-1" })).record as Json;
    expect(tested).toMatchObject({ recordType: "pregnancy_test", head: 40, inCalf: 36, inCalfPercent: "90.0" });
    // Sent again with the same key: the same record, not a second one.
    const again = (await call(tokens["staff-records"], "record_breeding", { mobId: homeMob.id, recordType: "pregnancy_test", onDate: "2026-11-10", head: 40, inCalf: 36, idempotencyKey: "staff-preg-test-1" })).record as Json;
    expect(again.id).toBe(tested.id);
    await expect(call(tokens["staff-records"], "record_breeding", { mobId: homeMob.id, recordType: "scanning", onDate: "2026-11-10", empty: 1, singles: 1, twins: 1 })).rejects.toThrow("pregnancy tested");
    await expect(call(tokens["staff-records"], "record_breeding", { mobId: farMob.id, recordType: "pregnancy_test", onDate: "2026-11-10", inCalf: 5 })).rejects.toThrow();
    await expect(call(tokens["staff-looks"], "record_breeding", { mobId: homeMob.id, recordType: "pregnancy_test", onDate: "2026-11-11", inCalf: 5 })).rejects.toThrow();
    await expect(call(tokens["staff-records"], "record_pond_reading", { farmId: home.id, pondId: "00000000-0000-4000-8000-000000000000", levelMm: 900 })).rejects.toThrow("Choose a pond");

    // Nothing of the books, the farm's money or the organisation.
    for (const name of ["profit_and_loss", "get_organisation", "list_invoices", "farm_home", "farm_benchmarks", "livestock_overview", "list_staff", "list_datasets", "create_draft_invoice", "list_fertiliser_plans"]) {
      await expect(call(tokens["staff-records"], name, {}), name).rejects.toThrow();
    }
    await expect(call(tokens["staff-records"], "farm_home", {})).rejects.toThrow("isn't part of farm field work");
  });
});
