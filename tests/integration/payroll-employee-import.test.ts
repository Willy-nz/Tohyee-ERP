import { afterAll, beforeAll, expect, it } from "vitest";
import * as importRoute from "@/app/api/payroll/employees/import/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listEmployees } from "@/lib/payroll/employees";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "payroll-employee-import-co";
const noContext = undefined as unknown;

/** An HR system's export: its own headings, US-style pay words, a department column Tohyee doesn't use (made-up people). */
const EXPORT = [
  "Employee #,First Name,Last Name,Work Email,Hire Date,Termination Date,Job Title,Department,Pay rate,Pay type,Paid per,Pay Schedule,IRD Number,Standard Hours",
  "101,Aroha,Ngata,aroha@koru.test,1/04/2025,,Workshop lead,Production,\"$62,000.00 NZD\",Salary,Year,Fortnightly,123456789,",
  "102,Sione,Fifita,sione@koru.test,15/09/2025,,Jeweller,Production,28.50 NZD,Hourly,Hour,Weekly,123456789,32",
  "103,Kiri,Tane,kiri@koru.test,3/02/2026,,Packer,Dispatch,24.00 NZD,Hourly,Hour,Every other week,123456789,",
].join("\n");

/**
 * Examples EMI1-EMI8 in docs/ACCOUNTING-EXAMPLES.md (employees from a file,
 * following common practice, not yet reviewed).
 */
describeWithDatabase("employees from a file (EMI1-EMI8)", () => {
  let server: TestServer;
  let owner: SessionUser;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;

  const post = async (body: Record<string, unknown>) => {
    const response = await importRoute.POST(
      apiRequest("/api/payroll/employees/import", { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: ORG, fileName: "employees.csv", ...body } }),
      noContext as never,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const file = (text: string) => Buffer.from(text, "utf8").toString("base64");
  const defaults = { taxCode: "M", kiwiSaverStatus: "enrolled", kiwiSaverEmployeeRate: "3.5", kiwiSaverEmployerRate: "3.5", studentLoan: "no" };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-employee-import-secret-key-32-characters";
    server = await startTestServer();
    owner = await createTestUser("owner@employee-import.test");
    await createTestOrganisation(owner, ORG);
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("EMI2: columns are matched by their headings, and an unknown column is left out", async () => {
    const { status, body } = await post({ fileBase64: file(EXPORT), defaults });
    expect(status).toBe(200);
    expect(body.mapping).toMatchObject({ firstName: 1, lastName: 2, email: 3, startDate: 4, finishDate: 5, jobTitle: 6, payRate: 8, payType: 9, payPer: 10, payFrequency: 11, irdNumber: 12, hoursPerWeek: 13 });
  });

  it("EMI4, EMI6: payroll details the file hasn't got must be chosen; Kiri, hourly, has no hours", async () => {
    const without = await post({ fileBase64: file(EXPORT) });
    expect((without.body.problems as Array<{ row: number; message: string }>)[0]).toMatchObject({ row: 2, message: expect.stringContaining("is missing. Add a column for it, or choose one for everyone without it.") });
    const preview = await post({ fileBase64: file(EXPORT), defaults });
    expect(preview.body.committed).toBe(false);
    expect(preview.body.problems).toEqual([{ row: 4, message: "Hours per week is missing for an hourly employee." }]);
  });

  it("EMI1, EMI3, EMI5, EMI6: a good file is previewed, then brought in; salary, hourly and pay frequency are read", async () => {
    const fixed = EXPORT.replace("Every other week,123456789,", "Every other week,123456789,20");
    const preview = await post({ fileBase64: file(fixed), defaults });
    expect(preview.body).toMatchObject({ committed: false, problems: [], counts: { create: 3, skip: 0 } });
    expect(await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => listEmployees(tx, {}))).toHaveLength(0);
    const done = await post({ fileBase64: file(fixed), defaults, commit: true, idempotencyKey: key("import") });
    expect(done.body).toMatchObject({ committed: true, counts: { create: 3, skip: 0 } });
    const employees = await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => listEmployees(tx, {}));
    const byName = new Map(employees.map((employee) => [`${employee.firstName} ${employee.lastName}`, employee]));
    expect(byName.get("Aroha Ngata")).toMatchObject({ startDate: "2025-04-01", jobTitle: "Workshop lead", payFrequency: "fortnightly", taxCode: "M", kiwiSaverStatus: "enrolled" });
    expect(byName.get("Sione Fifita")).toMatchObject({ startDate: "2025-09-15", payFrequency: "weekly" });
    expect(byName.get("Kiri Tane")).toMatchObject({ startDate: "2026-02-03", payFrequency: "fortnightly" });

    // EMI7: the same file again changes nothing.
    const again = await post({ fileBase64: file(fixed), defaults, commit: true, idempotencyKey: key("import") });
    expect(again.body).toMatchObject({ committed: false, counts: { create: 0, skip: 3 } });
  });

  it("EMI8: a row the rules refuse stops the whole file", async () => {
    const bad = "First Name,Last Name,Hire Date,Pay rate,Pay type,IRD Number,Pay Schedule\nMere,Tipene,1/05/2026,50000,Salary,12345,Monthly\nHemi,Walker,1/05/2026,50000,Salary,123456789,Twice a month";
    const result = await post({ fileBase64: file(bad), defaults, commit: true, idempotencyKey: key("import") });
    expect(result.body.committed).toBe(false);
    const problems = result.body.problems as Array<{ row: number; message: string }>;
    expect(problems.map((problem) => problem.row)).toEqual([2, 3]);
    expect(problems[1].message).toContain("isn't weekly, fortnightly, four-weekly or monthly");
  });
});
