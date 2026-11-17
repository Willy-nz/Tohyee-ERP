import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { createCustomReport, type CustomReport, getCustomReport, updateCustomReport } from "@/lib/reports/custom";
import type { ComputedBlock, CustomReportFigures, CustomReportLayout, FinancialReportBase, ReportRow } from "@/lib/reports/custom-layout";
import type { CashFlowFigures, CashFlowFigureSection } from "@/lib/reports/cash-flow-layout";
import type { EquityFigures } from "@/lib/reports/equity-layout";
import { buildFinancialStatements, financialStatementsPdf } from "@/lib/reports/financial-statements";
import { setLayoutDefault } from "@/lib/reports/report-layouts";
import type { ReportRounding } from "@/lib/reports/rounding";
import { statementValue } from "@/lib/reports/statement-format";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Examples RND1-RND5 in docs/ACCOUNTING-EXAMPLES.md ("Rounded figures"). */
describeWithDatabase("rounded figures on report layouts", () => {
  let server: TestServer;
  let owner: SessionUser;
  const org = "report-rounding-co";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, org);
    const journal = (debit: string, credit: string, amount: string) =>
      as((tx) =>
        postJournal(tx, {
          idempotencyKey: key("journal"),
          postingDate: "2026-06-10",
          reference: "Setup",
          lines: [
            { accountCode: debit, debitAmount: amount, creditAmount: "0" },
            { accountCode: credit, debitAmount: "0", creditAmount: amount },
          ],
        }),
      );
    await journal("1000", "3000", "10000.00");
    await journal("1000", "4000", "1400.40");
    await journal("1000", "4100", "1400.40");
    await journal("6000", "1000", "300.40");
    await journal("6010", "1000", "300.40");
    await journal("6020", "1000", "300.40");
    await journal("1600", "1000", "2500.40");
    await journal("1000", "2800", "1500.50");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const tables = (figures: CustomReportFigures) => figures.blocks.filter((block): block is Extract<ComputedBlock, { kind: "table" }> => block.kind === "table");
  /** Every row and account line by its label, first column. */
  const shown = (figures: CustomReportFigures) => {
    const out: Record<string, string | null> = {};
    for (const table of tables(figures)) {
      for (const row of table.rows) {
        if (row.kind === "heading" || row.hidden) continue;
        out[row.label] = row.values.p0;
        for (const line of row.lines) out[line.name] = line.values.p0;
      }
    }
    return out;
  };
  const run = async (base: FinancialReportBase, rounding: ReportRounding | undefined, change: (rows: ReportRow[]) => void = () => undefined) => {
    const report = (await as((tx) => createCustomReport(tx, { idempotencyKey: key("create"), base, periodEnd: "2026-06-30" }))).report as CustomReport & { layout: CustomReportLayout };
    const layout = structuredClone(report.layout);
    if (rounding) layout.columns.rounding = rounding;
    for (const block of layout.blocks) {
      if (block.kind !== "table") continue;
      for (const row of block.rows) if (row.kind === "group") row.showAccounts = true;
      change(block.rows);
    }
    const saved = await as((tx) => updateCustomReport(tx, report.id, { layout, version: report.version }));
    return saved.figures as CustomReportFigures;
  };

  it("to the cent, nothing changes", async () => {
    const figures = await run("profit_and_loss", undefined);
    expect(figures.rounding).toBeUndefined();
    expect(shown(figures)).toMatchObject({ Sales: "1400.40", "Other revenue": "1400.40", Revenue: "2800.80", Expenses: "901.20", "Net profit": "1899.60" });
  });

  it("RND1: in whole dollars each account is rounded and every total adds up the rounded lines", async () => {
    const figures = await run("profit_and_loss", "whole");
    expect(figures.rounding).toBe("whole");
    expect(shown(figures)).toMatchObject({
      Sales: "1400.00",
      "Other revenue": "1400.00",
      // 2,800.80 by itself would be 2,801; the lines above it add to 2,800.
      Revenue: "2800.00",
      "Advertising and marketing": "300.00",
      "Accounting fees": "300.00",
      "Bank fees": "300.00",
      Expenses: "900.00",
      "Net profit": "1900.00",
    });
  });

  it("RND2: a group shown as one line is rounded as one line", async () => {
    const figures = await run("profit_and_loss", "whole", (rows) => {
      const revenue = rows.find((row) => row.kind === "group" && row.label === "Revenue");
      if (revenue?.kind === "group") revenue.showAccounts = false;
    });
    expect(shown(figures)).toMatchObject({ Revenue: "2801.00", Expenses: "900.00", "Net profit": "1901.00" });
  });

  it("RND3: in thousands the same rule holds, with amounts still in dollars", async () => {
    const figures = await run("profit_and_loss", "thousands");
    expect(shown(figures)).toMatchObject({ Sales: "1000.00", "Other revenue": "1000.00", Revenue: "2000.00", Expenses: "0.00", "Net profit": "2000.00" });
  });

  it("RND4: a rounded balance sheet balances through the current year's earnings", async () => {
    const exact = shown(await run("balance_sheet", undefined));
    expect(exact).toMatchObject({ "Business bank account": "10899.70", "Office equipment": "2500.40", "Term loan": "1500.50", "Owner funds introduced": "10000.00" });
    const figures = await run("balance_sheet", "whole");
    const rounded = shown(figures);
    expect(rounded).toMatchObject({ "Business bank account": "10900.00", "Office equipment": "2500.00", "Term loan": "1501.00", "Owner funds introduced": "10000.00" });
    // Assets 13,400 less liabilities 1,501 is 11,899, so earnings show 1,899 (not 1,900) and equity is 11,899 too.
    const earnings = tables(figures).flatMap((table) => table.rows).find((row) => row.kind === "earnings" && row.values.p0 !== "0.00");
    expect(earnings?.values.p0).toBe("1899.00");
    expect(rounded).toMatchObject({ "Net assets": "11899.00", "Total equity": "11899.00" });
    // In thousands: bank 11, equipment 3, loan 2, so net assets 12; funds 10, so earnings show 2.
    const thousands = shown(await run("balance_sheet", "thousands"));
    expect(thousands).toMatchObject({ "Business bank account": "11000.00", "Office equipment": "3000.00", "Term loan": "2000.00", "Net assets": "12000.00", "Total equity": "12000.00" });
  });

  it("RND6: rounded cash flows and changes in equity add up to the rounded cash and equity", async () => {
    const make = async (base: "cash_flows" | "changes_in_equity", rounding: ReportRounding) => {
      const report = (await as((tx) => createCustomReport(tx, { idempotencyKey: key("create"), base, periodEnd: "2026-06-30" }))).report;
      const layout = structuredClone(report.layout) as { columns: { rounding?: ReportRounding } };
      layout.columns.rounding = rounding;
      return (await as((tx) => updateCustomReport(tx, report.id, { layout, version: report.version }))).figures;
    };
    const cash = (await make("cash_flows", "whole")) as CashFlowFigures;
    expect(cash.rounding).toBe("whole");
    const sections = cash.blocks.filter((block): block is CashFlowFigureSection => block.kind === "section");
    const rowsOf = (usual: string) => Object.fromEntries(sections.find((section) => section.usual === usual)!.rows.map((row) => [row.label, row.values.p0]));
    // Profit 1,899.60 would round to 1,900; with 2,500 out and 11,501 in that gives 10,901, but cash is 10,900, so profit shows 1,899.
    expect(rowsOf("operating")).toMatchObject({ "Net profit": "1899.00" });
    expect(sections.map((section) => [section.usual, section.total.values.p0])).toEqual([
      ["operating", "1899.00"],
      ["investing", "-2500.00"],
      ["financing", "11501.00"],
    ]);
    expect(Object.fromEntries(cash.end.map((line) => [line.key, line.values.p0]))).toEqual({ netChange: "10900.00", openingCash: "0.00", closingCash: "10900.00" });
    expect(cash.reconciles).toBe(true);

    const equity = (await make("changes_in_equity", "thousands")) as EquityFigures;
    expect(equity.rounding).toBe("thousands");
    const groups = equity.blocks.flatMap((block) => (block.kind === "group" ? [block.values.p0] : []));
    expect(equity.opening.values.p0).toBe("0.00");
    expect(equity.closing.values.p0).toBe("12000.00");
    expect(groups.reduce((sum, value) => sum + Number(value), 0)).toBe(12000);
    expect(equity.reconciles).toBe(true);
  });

  it("RND7: the year-end statements follow a rounded default layout, in its units", async () => {
    const report = (await as((tx) => createCustomReport(tx, { idempotencyKey: key("create"), base: "profit_and_loss", periodEnd: "2026-06-30" }))).report as CustomReport & { layout: CustomReportLayout };
    const layout = structuredClone(report.layout);
    layout.columns.rounding = "thousands";
    for (const block of layout.blocks) if (block.kind === "table") for (const row of block.rows) if (row.kind === "group") row.showAccounts = true;
    await as((tx) => updateCustomReport(tx, report.id, { layout, version: report.version }));
    await as((tx) => setLayoutDefault(tx, { base: "profit_and_loss", reportId: report.id }));
    const statements = await as((tx) => buildFinancialStatements(tx, { yearEnd: "2027-03-31" }, new Date("2027-04-10T00:00:00Z")));
    const performance = statements.statements.find((statement) => statement.key === "performance")!;
    expect(performance.rounding).toBe("thousands");
    expect(performance.subtitle).toBe("For the year ended 31 March 2027 · In NZD thousands");
    const printed = Object.fromEntries(performance.lines.map((line) => [line.label, statementValue(line, line.current, performance.rounding)]));
    expect(printed).toMatchObject({ Sales: "1", "Other revenue": "1", "Total Revenue": "2", "Total Expenses": "-", "Net profit": "2" });
    // A statement with no rounded layout prints to the cent as before.
    const position = statements.statements.find((statement) => statement.key === "position")!;
    expect(position.rounding).toBeUndefined();
    expect(position.subtitle).not.toContain("thousands");
    const pdf = await as((tx) => financialStatementsPdf(tx, { yearEnd: "2027-03-31" }, new Date("2027-04-10T00:00:00Z")));
    expect(pdf.bytes.length).toBeGreaterThan(1000);
  });

  it("RND5: rounding is whole, thousands or millions", async () => {
    const report = (await as((tx) => createCustomReport(tx, { idempotencyKey: key("create"), base: "profit_and_loss", periodEnd: "2026-06-30" }))).report as CustomReport & { layout: CustomReportLayout };
    const layout = structuredClone(report.layout) as unknown as { columns: { rounding?: unknown } };
    layout.columns.rounding = "hundreds";
    await expect(as((tx) => updateCustomReport(tx, report.id, { layout, version: report.version }))).rejects.toThrow("Rounding is whole, thousands or millions");
    layout.columns.rounding = "none";
    const saved = await as((tx) => updateCustomReport(tx, report.id, { layout, version: report.version }));
    expect((saved.report.layout as CustomReportLayout).columns.rounding).toBeUndefined();
    expect((await as((tx) => getCustomReport(tx, report.id))).figures).not.toHaveProperty("rounding");
  });
});
