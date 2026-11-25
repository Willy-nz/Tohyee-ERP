import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as itemRoute from "@/app/api/spreading/items/[itemId]/route";
import * as itemsRoute from "@/app/api/spreading/items/route";
import * as monthsRoute from "@/app/api/spreading/months/route";
import * as linesRoute from "@/app/api/spreading/lines/route";
import * as worksheetRoute from "@/app/api/spreading/route";
import * as undoRoute from "@/app/api/spreading/runs/[runId]/undo/route";
import * as settingsRoute from "@/app/api/spreading/settings/route";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts } from "@/lib/bank/accounts";
import { createBankTransaction, voidBankTransaction } from "@/lib/bank/transactions";
import { approveBill, createBill, voidBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice, voidInvoice } from "@/lib/invoices/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { correctJournal, getJournal, getJournalDetails, postJournal } from "@/lib/ledger/journals";
import { planVoidJournals, voidJournals } from "@/lib/ledger/void-journals";
import { recodeLine } from "@/lib/ledger/recode";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createCustomField } from "@/lib/custom-fields/service";
import { createTrackingValue, getTrackingSetup, updateTrackingCategory } from "@/lib/tracking/service";
import { postSpreadMonth, previewSpreadMonth, undoSpreadRun } from "@/lib/spreading/runs";
import type { SpreadKind } from "@/lib/spreading/rules";
import {
  createSpreadItem,
  endSpreadItemEarly,
  getSpreadItem,
  getSpreadWorksheet,
  markSpreadItemDone,
  removeSpreadItem,
  saveSpreadingSettings,
  settleSpreadItem,
  unsettleSpreadItem,
  updateSpreadItemTags,
} from "@/lib/spreading/service";
import { explainSpreadDifference } from "@/lib/spreading/explain";
import { importSpreadItems, monthJournalFile, worksheetFile } from "@/lib/spreading/files";
import { listSourceLines } from "@/lib/spreading/sources";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;

/** Examples SW1-SW14 in docs/ACCOUNTING-EXAMPLES.md ("Spreading"). Each test gets its own organisation. */
describeWithDatabase("spreading", () => {
  let server: TestServer;
  let owner: SessionUser;
  let aroha: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("sw-jade@example.com", { serverAdmin: true });
    aroha = await createTestUser("sw-aroha@example.com");
    viewer = await createTestUser("sw-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `sw-${organisations}-co`;
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [aroha, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const asAroha = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: aroha.id, email: aroha.email }, work);
    const settings = await as((tx) => saveSpreadingSettings(tx, {}));
    const journal = (postingDate: string, reference: string, lines: Array<[string, string, string]>) =>
      as((tx) => postJournal(tx, { idempotencyKey: key("journal"), postingDate, reference, lines: lines.map(([accountCode, debitAmount, creditAmount]) => ({ accountCode, debitAmount, creditAmount })) }));
    const add = async (fields: Record<string, unknown>, idempotencyKey = key("item")) => (await asAroha((tx) => createSpreadItem(tx, { idempotencyKey, ...fields }))).item;
    const post = async (kind: SpreadKind, month: string, idempotencyKey = key("month")) => (await asAroha((tx) => postSpreadMonth(tx, { idempotencyKey, kind, month }))).run;
    const undo = async (runId: string, idempotencyKey = key("undo")) => (await asAroha((tx) => undoSpreadRun(tx, runId, { idempotencyKey }))).run;
    const lines = async (journalId: string | null) =>
      (await as((tx) => getJournal(tx, journalId as string))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
    const balance = async (code: string) =>
      (
        await as((tx) =>
          tx.query<{ balance: string }>(
            "select coalesce(sum(l.debit_amount - l.credit_amount), 0)::numeric(18,2)::text as balance from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = $1",
            [code],
          ),
        )
      ).rows[0].balance;
    const worksheet = () => as((tx) => getSpreadWorksheet(tx));
    const tie = async (kind: SpreadKind) => (await worksheet()).tieOut.find((row) => row.kind === kind)!;
    const item = (id: string) => as((tx) => getSpreadItem(tx, id));
    const journals = async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    /** SW1's insurance: the bill's amount without GST sits on 1200, and the item spreads it over the year. */
    const insurance = async (amount = "1200.00") => {
      await journal("2026-07-01", "INS-BILL", [
        ["1200", amount, "0"],
        ["2000", "0", amount],
      ]);
      return add({ kind: "prepayment", description: "Farm insurance", targetAccountCode: "6080", amount, startDate: "2026-07-01", endDate: "2027-06-30" });
    };
    return { org, as, asAroha, settings, journal, add, post, undo, lines, balance, worksheet, tie, item, journals, insurance };
  }

  it("turning it on keeps 1200 for prepayments and adds the other three accounts once", async () => {
    const w = await setup();
    expect(w.settings.prepayment?.code).toBe("1200");
    expect(w.settings.accrued_income?.name).toBe("Accrued income");
    expect(w.settings.income_in_advance?.name).toBe("Income in advance");
    expect(w.settings.accrued_expense?.name).toBe("Accrued expenses");
    const again = await w.as((tx) => saveSpreadingSettings(tx, {}));
    expect(again).toEqual(w.settings);
    expect((await w.worksheet()).ready).toBe(true);
    // An account of the wrong type, or one account for two kinds, is refused.
    await expect(w.as((tx) => saveSpreadingSettings(tx, { accounts: { prepayment: "6080" } }))).rejects.toThrow(/isn't a current asset/);
    await expect(w.as((tx) => saveSpreadingSettings(tx, { accounts: { accrued_income: "1200" } }))).rejects.toThrow(/different account for each kind/);
  });

  it("SW1, SW11, SW14: evenly by month, one journal on the month end, and it ties out", async () => {
    const w = await setup();
    const item = await w.insurance();
    expect(item.months).toHaveLength(12);
    expect(item.left).toBe("1200.00");
    expect((await w.tie("prepayment")).difference).toBe("0.00");

    const preview = await w.as((tx) => previewSpreadMonth(tx, "prepayment", "2026-07"));
    expect(preview).toMatchObject({ postingDate: "2026-07-31", reference: "SPREAD-PAID-2026-07", total: "100.00", blocked: null, runId: null });
    const before = await w.journals();
    // August can't go before July.
    await expect(w.post("prepayment", "2026-08")).rejects.toThrow(/Post July 2026 first/);
    expect(await w.journals()).toBe(before);

    const monthKey = key("month");
    const july = await w.post("prepayment", "2026-07", monthKey);
    expect(july).toMatchObject({ month: "2026-07", total: "100.00", status: "active" });
    const posted = await w.as((tx) => getJournal(tx, july.journalId as string));
    expect(posted).toMatchObject({ postingDate: "2026-07-31", reference: "SPREAD-PAID-2026-07", origin: "spreading" });
    expect(await w.lines(july.journalId)).toEqual([
      ["6080", "100.00", "0.00"],
      ["1200", "0.00", "100.00"],
    ]);
    // The same key again posts nothing more; the month again is refused.
    expect((await w.post("prepayment", "2026-07", monthKey)).id).toBe(july.id);
    await expect(w.post("prepayment", "2026-07")).rejects.toThrow(/already posted for July 2026/);
    expect(await w.journals()).toBe(before + 1);

    await w.post("prepayment", "2026-08");
    const september = await w.post("prepayment", "2026-09");
    expect((await w.item(item.id)).left).toBe("900.00");
    expect(await w.balance("1200")).toBe("900.00");
    expect(await w.tie("prepayment")).toMatchObject({ worksheet: "900.00", ledger: "900.00", difference: "0.00" });
    await w.journal("2026-09-30", "ODD", [
      ["1200", "50.00", "0"],
      ["6080", "0", "50.00"],
    ]);
    expect((await w.tie("prepayment")).difference).toBe("50.00");

    // The journal can't be corrected in the ledger; the worksheet undoes it.
    expect((await w.as((tx) => getJournalDetails(tx, september.journalId as string))).canCorrect).toBe(false);
    await expect(
      w.as((tx) =>
        correctJournal(tx, {
          idempotencyKey: key("fix"),
          originalJournalId: september.journalId,
          postingDate: "2026-09-30",
          reference: "Fix",
          lines: [
            { accountCode: "6080", debitAmount: "1.00" },
            { accountCode: "1200", creditAmount: "1.00" },
          ],
        }),
      ),
    ).rejects.toThrow(/undo that month on the worksheet/);
    // Only the latest month, with the exact reversal on the same date.
    await expect(w.undo(july.id)).rejects.toThrow(/Only the latest month can be undone. Undo September 2026 first/);
    const undone = await w.undo(september.id);
    expect(undone.status).toBe("undone");
    const reversal = await w.as((tx) => getJournal(tx, undone.undoJournalId as string));
    expect(reversal).toMatchObject({ postingDate: "2026-09-30", reference: "VOID-SPREAD-PAID-2026-09" });
    expect(await w.lines(undone.undoJournalId)).toEqual([
      ["6080", "0.00", "100.00"],
      ["1200", "100.00", "0.00"],
    ]);
    expect((await w.item(item.id)).left).toBe("1000.00");
    // And September can be posted again.
    expect((await w.post("prepayment", "2026-09")).total).toBe("100.00");
  });

  it("SW14: an empty month posts no journal and still counts, and the kinds don't touch each other", async () => {
    const w = await setup();
    await w.insurance();
    const before = await w.journals();
    const empty = await w.post("income_in_advance", "2026-07");
    expect(empty).toMatchObject({ total: "0.00", journalId: null, status: "active" });
    expect(await w.journals()).toBe(before);
    // Prepayments still start at July, whatever income in advance has done.
    expect((await w.post("prepayment", "2026-07")).total).toBe("100.00");
    expect((await w.worksheet()).posted.income_in_advance?.month).toBe("2026-07");
    // A new item can't start in a month its kind has posted.
    // A new item for a month its kind has posted is caught up in the next one (SW18).
    const late = await w.add({ kind: "income_in_advance", description: "Late", targetAccountCode: "4000", amount: "100", method: "one_month", month: "2026-07" });
    expect(late.months).toEqual([{ month: "2026-08", lineKind: "share", amount: "100.00", runId: null }]);
    expect((await w.undo(empty.id)).undoJournalId).toBeNull();
  });

  it("SW4, SW5, SW12: income in advance by month, in one month, and when it's done", async () => {
    const w = await setup();
    const held = w.settings.income_in_advance!.code;
    await w.journal("2026-10-01", "INV-SUB", [
      ["1100", "5900.00", "0"],
      [held, "0", "5900.00"],
    ]);
    const subscription = await w.add({ kind: "income_in_advance", description: "Year's subscription", targetAccountCode: "4000", amount: "2,400.00", startDate: "2026-10-01", endDate: "2027-09-30" });
    const deposit = await w.add({ kind: "income_in_advance", description: "Event deposit", targetAccountCode: "4000", amount: "500.00", method: "one_month", month: "2027-03" });
    const job = await w.add({ kind: "income_in_advance", description: "Shed build", targetAccountCode: "4000", amount: "3000.00", method: "when_done" });
    expect(job).toMatchObject({ waiting: true, months: [], left: "3000.00" });
    expect(await w.tie("income_in_advance")).toMatchObject({ worksheet: "5900.00", ledger: "5900.00", difference: "0.00" });

    const october = await w.post("income_in_advance", "2026-10");
    expect(await w.lines(october.journalId)).toEqual([
      ["4000", "0.00", "200.00"],
      [held, "200.00", "0.00"],
    ]);
    for (const month of ["2026-11", "2026-12", "2027-01"]) await w.post("income_in_advance", month);
    // Done in a month already posted is refused; February is fine.
    await expect(w.asAroha((tx) => markSpreadItemDone(tx, job.id, { month: "2027-01" }))).rejects.toThrow(/already posted to 2027-01/);
    await expect(w.asAroha((tx) => markSpreadItemDone(tx, deposit.id, { month: "2027-02" }))).rejects.toThrow(/When it's done/);
    const done = await w.asAroha((tx) => markSpreadItemDone(tx, job.id, { month: "2027-02" }));
    expect(done).toMatchObject({ waiting: false, months: [{ month: "2027-02", amount: "3000.00", runId: null }] });
    const february = await w.post("income_in_advance", "2027-02");
    expect(february.total).toBe("3200.00");
    expect((await w.item(job.id)).finished).toBe(true);
    const march = await w.post("income_in_advance", "2027-03");
    expect(march.total).toBe("700.00");
    expect((await w.item(deposit.id)).left).toBe("0.00");
    expect((await w.item(subscription.id)).left).toBe("1200.00");
    expect(await w.tie("income_in_advance")).toMatchObject({ worksheet: "1200.00", ledger: "1200.00", difference: "0.00" });
  });

  it("SW6: an accrual, its bill, and the difference either way", async () => {
    const w = await setup();
    const held = w.settings.accrued_expense!.code;
    await w.as((tx) => createAccount(tx, { code: "6470", name: "Rates", accountType: "expense" }));
    const rates = await w.add({ kind: "accrued_expense", description: "Rates", targetAccountCode: "6470", amount: "900.00", startDate: "2026-07-01", endDate: "2026-09-30" });
    const power = await w.add({ kind: "accrued_expense", description: "Power", targetAccountCode: "6470", amount: "900.00", startDate: "2026-07-01", endDate: "2026-09-30" });
    for (const month of ["2026-07", "2026-08", "2026-09"]) {
      const run = await w.post("accrued_expense", month);
      expect(run.total).toBe("600.00");
    }
    expect((await w.item(rates.id))).toMatchObject({ left: "900.00", finished: false });
    expect(await w.tie("accrued_expense")).toMatchObject({ worksheet: "1800.00", ledger: "1800.00" });
    // The bills, coded to Accrued expenses by the person.
    await w.journal("2026-10-05", "RATES-BILL", [
      [held, "920.00", "0"],
      ["2000", "0", "920.00"],
    ]);
    await w.journal("2026-10-06", "POWER-BILL", [
      [held, "880.00", "0"],
      ["2000", "0", "880.00"],
    ]);
    await expect(w.asAroha((tx) => settleSpreadItem(tx, rates.id, { month: "2026-09", amount: "920.00" }))).rejects.toThrow(/already posted to 2026-09/);
    const billed = await w.asAroha((tx) => settleSpreadItem(tx, rates.id, { month: "2026-10", amount: "920.00" }));
    expect(billed).toMatchObject({ settledMonth: "2026-10", settledAmount: "920.00", left: "-20.00" });
    expect(billed.months.at(-1)).toMatchObject({ month: "2026-10", lineKind: "difference", amount: "20.00" });
    await w.asAroha((tx) => settleSpreadItem(tx, power.id, { month: "2026-10", amount: "880.00" }));
    await expect(w.asAroha((tx) => settleSpreadItem(tx, power.id, { month: "2026-10", amount: "880.00" }))).rejects.toThrow(/already marked/);
    const october = await w.post("accrued_expense", "2026-10");
    expect(october.total).toBe("0.00");
    expect(await w.lines(october.journalId)).toEqual([
      ["6470", "20.00", "0.00"],
      [held, "0.00", "20.00"],
      ["6470", "0.00", "20.00"],
      [held, "20.00", "0.00"],
    ]);
    expect(await w.item(rates.id)).toMatchObject({ left: "0.00", finished: true });
    expect(await w.balance(held)).toBe("0.00");
    expect(await w.balance("6470")).toBe("1800.00");
    expect((await w.tie("accrued_expense")).difference).toBe("0.00");
    // September was what the bills were measured against, so it stays.
    const runs = await w.as((tx) => tx.query<{ id: string }>("select id::text from spread_runs where kind = 'accrued_expense' and month = '2026-09-01'"));
    await w.undo(october.id);
    await expect(w.undo(runs.rows[0].id)).rejects.toThrow(/can't be undone/);
  });

  it("SW7: accrued income with no difference posts nothing more", async () => {
    const w = await setup();
    const held = w.settings.accrued_income!.code;
    const work = await w.add({ kind: "accrued_income", description: "Fencing job", targetAccountCode: "4000", amount: "1500.00", method: "one_month", month: "2026-11" });
    const november = await w.post("accrued_income", "2026-11");
    expect(await w.lines(november.journalId)).toEqual([
      ["4000", "0.00", "1500.00"],
      [held, "1500.00", "0.00"],
    ]);
    await w.journal("2026-12-03", "INV-FENCE", [
      ["1100", "1500.00", "0"],
      [held, "0", "1500.00"],
    ]);
    const invoiced = await w.asAroha((tx) => settleSpreadItem(tx, work.id, { month: "2026-12", amount: "1500.00" }));
    expect(invoiced).toMatchObject({ left: "0.00", finished: true });
    expect(invoiced.months).toHaveLength(1);
    expect((await w.post("accrued_income", "2026-12")).journalId).toBeNull();
    expect((await w.tie("accrued_income")).difference).toBe("0.00");
    // Only an accrual is settled; only a dated item is ended early.
    await expect(w.asAroha((tx) => endSpreadItemEarly(tx, work.id, { month: "2027-01" }))).rejects.toThrow(/accrual ends when/);
  });

  it("SW8: ending early moves what's left into one month", async () => {
    const w = await setup();
    const item = await w.insurance();
    for (const month of ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"]) await w.post("prepayment", month);
    await expect(w.asAroha((tx) => endSpreadItemEarly(tx, item.id, { month: "2027-02" }))).rejects.toThrow(/already posted to 2027-02/);
    const ended = await w.asAroha((tx) => endSpreadItemEarly(tx, item.id, { month: "2027-03" }));
    expect(ended.months).toHaveLength(9);
    expect(ended.months.at(-1)).toMatchObject({ month: "2027-03", amount: "400.00", runId: null });
    const march = await w.post("prepayment", "2027-03");
    expect(march.total).toBe("400.00");
    expect(await w.item(item.id)).toMatchObject({ left: "0.00", finished: true });
    expect(await w.balance("1200")).toBe("0.00");
    await expect(w.asAroha((tx) => removeSpreadItem(tx, item.id))).rejects.toThrow(/can't be removed/);
  });

  it("SW9, SW13: the whole amount when there's no GST to claim, and your own amounts", async () => {
    const w = await setup();
    const item = await w.insurance("1380.00");
    expect(item.months.every((row) => row.amount === "115.00")).toBe(true);
    const own = [
      { month: "2026-10", amount: "250.00" },
      { month: "2026-11", amount: "150.00" },
      { month: "2026-12", amount: "600.00" },
    ];
    const itemKey = key("item");
    const fields = { kind: "prepayment", description: "Licence", targetAccountCode: "6080", amount: "1000.00", method: "own_amounts", ownAmounts: own };
    const licence = await w.add(fields, itemKey);
    expect(licence.months.map((row) => row.amount)).toEqual(["250.00", "150.00", "600.00"]);
    expect((await w.add(fields, itemKey)).id).toBe(licence.id);
    await expect(w.add({ ...fields, ownAmounts: [own[0], { month: "2026-11", amount: "600.00" }] })).rejects.toThrow("Your amounts add up to 850.00, not 1000.00.");
    // Income can't land on an expense account, and the other way round.
    await expect(w.add({ ...fields, targetAccountCode: "4000" })).rejects.toThrow(/isn't an expense account/);
    // Nothing has posted for it, so it can come off.
    await w.asAroha((tx) => removeSpreadItem(tx, licence.id));
    expect((await w.worksheet()).items.map((row) => row.id)).toEqual([item.id]);
  });

  it("SW10: a locked month is refused and nothing moves", async () => {
    const w = await setup();
    const item = await w.insurance();
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-07-31" }));
    const preview = await w.as((tx) => previewSpreadMonth(tx, "prepayment", "2026-07"));
    expect(preview.blocked).toMatch(/July 2026 is locked/);
    const before = await w.journals();
    await expect(w.post("prepayment", "2026-07")).rejects.toThrow(/July 2026 is locked/);
    expect(await w.journals()).toBe(before);
    expect((await w.item(item.id)).months[0]).toMatchObject({ month: "2026-07", amount: "100.00", runId: null });
    // August still waits for July.
    await expect(w.post("prepayment", "2026-08")).rejects.toThrow(/Post July 2026 first/);
  });

  it("SW15, SW17: Spread this on a bill line moves it on the bill date, carries tracking, and can be taken back", async () => {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const department = (await w.as((tx) => getTrackingSetup(tx))).categories.find((c) => c.kind === "department")!.id;
    const farm = (await w.as((tx) => createTrackingValue(tx, { categoryId: department, name: "Farm" }))).categories.find((c) => c.id === department)!.values.find((v) => v.name === "Farm")!.id;
    const supplier = (await w.as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "FMG", isSupplier: true }))).contact;
    const bill = (
      await w.as((tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: supplier.id,
          billDate: "2026-07-01",
          dueDate: "2026-07-20",
          supplierInvoiceNumber: "INS-778",
          amountsMode: "exclusive",
          lines: [
            { description: "Farm insurance", quantity: "1", unitPrice: "1200.00", accountCode: "6080", taxCode: "GST", tracking: { [department]: farm } },
            { description: "Laptop", quantity: "1", unitPrice: "2000.00", accountCode: "1620", taxCode: "GST" },
          ],
        }),
      )
    ).bill;
    const [insuranceLine, laptopLine] = (await w.as((tx) => listSourceLines(tx, "bill", bill.id))).map((line) => ({ id: line.lineId }));
    const fields = { billLineId: insuranceLine.id, startDate: "2026-07-01", endDate: "2027-06-30" };
    await expect(w.add(fields)).rejects.toThrow(/Approve the bill first/);
    await w.as((tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve") }));
    expect(await w.balance("6080")).toBe("1200.00");
    await expect(w.add({ ...fields, billLineId: laptopLine.id })).rejects.toThrow(/isn't an expense account/);

    const itemKey = key("item");
    const item = await w.add(fields, itemKey);
    expect(item).toMatchObject({ kind: "prepayment", description: "Farm insurance", amount: "1200.00", left: "1200.00", contactId: supplier.id, tracking: { [department]: farm } });
    expect(item.target.code).toBe("6080");
    expect(item.source).toMatchObject({ kind: "bill", documentId: bill.id, label: "Bill INS-778 from FMG" });
    expect((await w.add(fields, itemKey)).id).toBe(item.id);
    await expect(w.add(fields)).rejects.toThrow(/already on the Spreading worksheet/);
    // One journal on the bill's date moved the amount without GST; the GST and the payable stay put.
    const move = await w.as((tx) => tx.query<{ id: string; posting_date: string; reference: string; origin: string }>("select j.id::text, to_char(j.posting_date, 'YYYY-MM-DD') as posting_date, j.reference, j.origin from ledger_journals j join spread_items i on i.move_journal_id = j.id where i.id = $1", [item.id]));
    expect(move.rows[0]).toMatchObject({ posting_date: "2026-07-01", reference: `SPREAD-MOVE-${item.id}`, origin: "spreading" });
    expect(await w.lines(move.rows[0].id)).toEqual([
      ["1200", "1200.00", "0.00"],
      ["6080", "0.00", "1200.00"],
    ]);
    expect(await w.balance("6080")).toBe("0.00");
    expect(await w.balance("2100")).toBe("480.00"); // 180.00 on the insurance and 300.00 on the laptop, untouched
    expect(await w.tie("prepayment")).toMatchObject({ worksheet: "1200.00", ledger: "1200.00", difference: "0.00" });
    // The bill's card lists the line as spreading.
    const listed = await linesRoute.GET(apiRequest(`/api/spreading/lines?organisationId=${w.org}&billId=${bill.id}`, { cookie: await sessionCookieFor(viewer) }), noContext);
    const card = (await listed.json()) as { holding: { code: string }; lines: Array<{ lineId: string; itemId: string | null; reason: string | null }> };
    expect(card.holding.code).toBe("1200");
    expect(card.lines.map((line) => [line.lineId, line.itemId, line.reason === null])).toEqual([
      [insuranceLine.id, item.id, true],
      [laptopLine.id, null, false],
    ]);

    // July's journal carries the line's tracking to the expense.
    const july = await w.post("prepayment", "2026-07");
    const posted = await w.as((tx) => getJournal(tx, july.journalId as string));
    expect(posted.lines.map((line) => [line.accountCode, line.debitAmount, line.tracking])).toEqual([
      ["6080", "100.00", { [department]: farm }],
      ["1200", "0.00", {}],
    ]);
    // The bill can't be voided, and the item can't come off, while a month is posted.
    await expect(w.as((tx) => voidBill(tx, bill.id, { idempotencyKey: key("void"), voidDate: "2026-07-01" }))).rejects.toThrow(/on the Spreading worksheet/);
    await expect(w.asAroha((tx) => removeSpreadItem(tx, item.id))).rejects.toThrow(/can't be removed/);
    // Nor can the line be recoded while it's there.
    await expect(w.as((tx) => recodeLine(tx, { idempotencyKey: key("recode"), documentType: "bill", documentId: bill.id, lineOrder: 1, accountCode: "6000", reason: "Wrong account" }))).rejects.toThrow(/on the Spreading worksheet/);
    await w.undo(july.id);
    await expect(w.as((tx) => voidBill(tx, bill.id, { idempotencyKey: key("void"), voidDate: "2026-07-01" }))).rejects.toThrow(/on the Spreading worksheet/);
    // Taken back: the exact reversal on the bill's date, and the expense holds it again.
    await w.asAroha((tx) => removeSpreadItem(tx, item.id));
    expect(await w.balance("6080")).toBe("1200.00");
    expect(await w.balance("1200")).toBe("0.00");
    const undo = await w.as((tx) => tx.query<{ posting_date: string; reference: string }>("select to_char(j.posting_date, 'YYYY-MM-DD') as posting_date, j.reference from ledger_journals j join spread_items i on i.move_undo_journal_id = j.id where i.id = $1", [item.id]));
    expect(undo.rows[0]).toEqual({ posting_date: "2026-07-01", reference: `VOID-SPREAD-MOVE-${item.id}` });
    // Now the line can be spread again, or the bill voided.
    const again = await w.add({ ...fields, description: "Insurance to June" });
    expect(again.description).toBe("Insurance to June");
    await w.asAroha((tx) => removeSpreadItem(tx, again.id));
    expect((await w.as((tx) => voidBill(tx, bill.id, { idempotencyKey: key("void"), voidDate: "2026-07-01" }))).bill.status).toBe("voided");
  });

  it("SW15: a bill dated in a locked period isn't moved", async () => {
    const w = await setup();
    const supplier = (await w.as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "FMG", isSupplier: true }))).contact;
    const bill = (
      await w.as((tx) =>
        createBill(tx, { idempotencyKey: key("bill"), contactId: supplier.id, billDate: "2026-07-01", dueDate: "2026-07-20", supplierInvoiceNumber: "INS-1", amountsMode: "exclusive", lines: [{ description: "Insurance", quantity: "1", unitPrice: "1200.00", accountCode: "6080", taxCode: "GST" }] }),
      )
    ).bill;
    await w.as((tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve") }));
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-07-31" }));
    const before = await w.journals();
    const lineId = (await w.as((tx) => listSourceLines(tx, "bill", bill.id)))[0].lineId;
    await expect(w.add({ billLineId: lineId, startDate: "2026-08-01", endDate: "2027-06-30" })).rejects.toThrow(/locked up to 2026-07-31/);
    expect(await w.journals()).toBe(before);
    expect((await w.worksheet()).items).toEqual([]);
  });

  it("SW16: Spread this on an invoice line moves it to Income in advance", async () => {
    const w = await setup();
    const held = w.settings.income_in_advance!.code;
    const customer = (await w.as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Hill Station", isCustomer: true }))).contact;
    const invoice = (
      await w.as((tx) =>
        createInvoice(tx, { idempotencyKey: key("invoice"), contactId: customer.id, invoiceDate: "2026-10-01", dueDate: "2026-10-20", amountsMode: "exclusive", lines: [{ description: "Year's subscription", quantity: "1", unitPrice: "2400.00", accountCode: "4000", taxCode: "GST" }] }),
      )
    ).invoice;
    const approved = (await w.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }))).invoice;
    const lineId = (await w.as((tx) => listSourceLines(tx, "invoice", invoice.id)))[0].lineId;
    const item = await w.add({ invoiceLineId: lineId, startDate: "2026-10-01", endDate: "2027-09-30" });
    expect(item).toMatchObject({ kind: "income_in_advance", description: "Year's subscription", amount: "2400.00", left: "2400.00" });
    expect(item.source).toMatchObject({ kind: "invoice", documentId: invoice.id, label: `Invoice ${approved.invoiceNumber}` });
    const move = await w.as((tx) => tx.query<{ id: string }>("select move_journal_id::text as id from spread_items where id = $1", [item.id]));
    expect(await w.lines(move.rows[0].id)).toEqual([
      [held, "0.00", "2400.00"],
      ["4000", "2400.00", "0.00"],
    ]);
    expect(await w.balance("4000")).toBe("0.00");
    expect(await w.balance("2100")).toBe("-360.00");
    expect((await w.tie("income_in_advance")).difference).toBe("0.00");
    const october = await w.post("income_in_advance", "2026-10");
    expect(await w.lines(october.journalId)).toEqual([
      ["4000", "0.00", "200.00"],
      [held, "200.00", "0.00"],
    ]);
    await expect(w.as((tx) => voidInvoice(tx, invoice.id, { idempotencyKey: key("void"), voidDate: "2026-10-01" }))).rejects.toThrow(/on the Spreading worksheet/);
  });

  it("SW18: months already posted are caught up in the next month, however the item was added", async () => {
    const w = await setup();
    await w.insurance();
    for (const month of ["2026-07", "2026-08", "2026-09", "2026-10"]) await w.post("prepayment", month);
    await w.journal("2026-07-01", "LATE-BILL", [
      ["1200", "1200.00", "0"],
      ["2000", "0", "1200.00"],
    ]);
    const result = await w.asAroha((tx) => createSpreadItem(tx, { idempotencyKey: key("item"), kind: "prepayment", description: "Second policy", targetAccountCode: "6080", amount: "1200.00", startDate: "2026-07-01", endDate: "2027-06-30" }));
    expect(result.caughtUp).toEqual({ months: 4, amount: "400.00", into: "2026-11" });
    expect(result.item.months).toHaveLength(8);
    expect(result.item.months[0]).toMatchObject({ month: "2026-11", amount: "500.00" });
    const november = await w.post("prepayment", "2026-11");
    expect(november.total).toBe("600.00");
    expect((await w.item(result.item.id)).left).toBe("700.00");
    expect((await w.tie("prepayment")).difference).toBe("0.00");
  });

  it("SW19: Spread this on a spend money line, which then can't be voided or recoded", async () => {
    const w = await setup();
    const bank = (await w.as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const supplier = (await w.as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "FMG", isSupplier: true }))).contact;
    const spend = (
      await w.as((tx) =>
        createBankTransaction(tx, { idempotencyKey: key("spend"), kind: "spend", accountId: bank.id, contactId: supplier.id, date: "2026-07-01", amountsMode: "inclusive", lines: [{ description: "Insurance", accountCode: "6080", taxCode: "GST", amount: "690.00" }] }),
      )
    ).bankTransaction;
    const [line] = await w.as((tx) => listSourceLines(tx, "bank", spend.id));
    expect(line).toMatchObject({ kind: "prepayment", accrualKind: "accrued_expense", amount: "600.00", reason: null, label: "Money spent 2026-07-01, FMG" });
    const item = await w.add({ bankLineId: line.lineId, startDate: "2026-07-01", endDate: "2027-06-30" });
    expect(item).toMatchObject({ kind: "prepayment", amount: "600.00", description: "Insurance" });
    expect(item.source).toMatchObject({ kind: "bank", documentId: spend.id });
    expect(await w.balance("6080")).toBe("0.00");
    expect(await w.balance("1200")).toBe("600.00");
    expect(await w.balance("2100")).toBe("90.00");
    expect((await w.tie("prepayment")).difference).toBe("0.00");
    await expect(w.as((tx) => voidBankTransaction(tx, spend.id, { idempotencyKey: key("void"), voidDate: "2026-07-01" }))).rejects.toThrow(/on the Spreading worksheet/);
    await expect(w.as((tx) => recodeLine(tx, { idempotencyKey: key("recode"), documentType: "bank_transaction", documentId: spend.id, lineOrder: 1, accountCode: "6000", reason: "Wrong account" }))).rejects.toThrow(/on the Spreading worksheet/);
    await w.asAroha((tx) => removeSpreadItem(tx, item.id));
    expect(await w.balance("6080")).toBe("600.00");
    expect((await w.as((tx) => voidBankTransaction(tx, spend.id, { idempotencyKey: key("void"), voidDate: "2026-07-01" }))).bankTransaction.status).toBe("voided");
  });

  it("SW20, SW21: the bill for an accrual, and undoing it", async () => {
    const w = await setup();
    const held = w.settings.accrued_expense!.code;
    await w.as((tx) => createAccount(tx, { code: "6470", name: "Rates", accountType: "expense" }));
    const rates = await w.add({ kind: "accrued_expense", description: "Rates", targetAccountCode: "6470", amount: "1200.00", startDate: "2026-07-01", endDate: "2026-10-31" });
    for (const month of ["2026-07", "2026-08", "2026-09"]) await w.post("accrued_expense", month);
    const council = (await w.as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Clutha District Council", isSupplier: true }))).contact;
    const bill = (
      await w.as((tx) =>
        createBill(tx, { idempotencyKey: key("bill"), contactId: council.id, billDate: "2026-10-05", dueDate: "2026-11-20", supplierInvoiceNumber: "R-55", amountsMode: "exclusive", lines: [{ description: "Rates instalment", quantity: "1", unitPrice: "920.00", accountCode: "6470", taxCode: "GST" }] }),
      )
    ).bill;
    await w.as((tx) => approveBill(tx, bill.id, { idempotencyKey: key("approve") }));
    const [line] = await w.as((tx) => listSourceLines(tx, "bill", bill.id));
    // The bill's card offers the accrual.
    const listed = await linesRoute.GET(apiRequest(`/api/spreading/lines?organisationId=${w.org}&billId=${bill.id}`, { cookie: await sessionCookieFor(viewer) }), noContext);
    expect(((await listed.json()) as { accruals: unknown[] }).accruals).toEqual([{ id: rates.id, description: "Rates", accrued: "900.00", targetCode: "6470", targetName: "Rates" }]);
    // An invoice can't settle a cost.
    const billed = await w.asAroha((tx) => settleSpreadItem(tx, rates.id, { billLineId: line.lineId }));
    expect(billed).toMatchObject({ settledMonth: "2026-10", settledAmount: "920.00", left: "-20.00", canUnsettle: true });
    expect(billed.source).toMatchObject({ kind: "bill", documentId: bill.id });
    // October's 300.00 share was dropped for the 20.00 difference.
    expect(billed.months.at(-1)).toMatchObject({ month: "2026-10", lineKind: "difference", amount: "20.00" });
    const move = await w.as((tx) => tx.query<{ id: string }>("select move_journal_id::text as id from spread_items where id = $1", [rates.id]));
    expect(await w.lines(move.rows[0].id)).toEqual([
      [held, "920.00", "0.00"],
      ["6470", "0.00", "920.00"],
    ]);
    expect(await w.balance(held)).toBe("20.00");
    expect((await w.tie("accrued_expense")).difference).toBe("0.00");
    await expect(w.as((tx) => voidBill(tx, bill.id, { idempotencyKey: key("void"), voidDate: "2026-10-05" }))).rejects.toThrow(/on the Spreading worksheet/);

    // SW21: undone, the dropped month is back and the bill's cost is on Rates again.
    const undone = await w.asAroha((tx) => unsettleSpreadItem(tx, rates.id));
    expect(undone).toMatchObject({ settledMonth: null, settledAmount: null, source: null, left: "900.00" });
    expect(undone.months.at(-1)).toMatchObject({ month: "2026-10", lineKind: "share", amount: "300.00", runId: null });
    expect(await w.balance(held)).toBe("-900.00");
    expect(await w.balance("6470")).toBe("1820.00");
    expect((await w.tie("accrued_expense")).difference).toBe("0.00");
    await expect(w.asAroha((tx) => unsettleSpreadItem(tx, rates.id))).rejects.toThrow(/hasn't been marked/);

    // Marked again, then October posts the difference; after that it can't be undone until October is.
    await w.asAroha((tx) => settleSpreadItem(tx, rates.id, { billLineId: line.lineId }));
    const october = await w.post("accrued_expense", "2026-10");
    expect(await w.lines(october.journalId)).toEqual([
      ["6470", "20.00", "0.00"],
      [held, "0.00", "20.00"],
    ]);
    expect(await w.balance(held)).toBe("0.00");
    expect(await w.balance("6470")).toBe("920.00");
    expect(await w.item(rates.id)).toMatchObject({ finished: true, canUnsettle: false, left: "0.00" });
    await expect(w.asAroha((tx) => unsettleSpreadItem(tx, rates.id))).rejects.toThrow(/Undo that month first/);
  });

  it("SW22: shop orders paid and not sent are one line that the check counts when they share the account", async () => {
    const w = await setup();
    const held = w.settings.income_in_advance!;
    await w.journal("2026-10-01", "SUB", [
      ["1100", "2750.00", "0"],
      [held.code, "0", "2750.00"],
    ]);
    await w.add({ kind: "income_in_advance", description: "Year's subscription", targetAccountCode: "4000", amount: "2400.00", startDate: "2026-10-01", endDate: "2027-09-30" });
    expect((await w.tie("income_in_advance")).difference).toBe("350.00");
    // What Sales when sent holds for an order, as it records it.
    const other = (await w.as((tx) => createAccount(tx, { code: "2590", name: "Deposits held", accountType: "current_liability" }))).id;
    const holdLine = async (accountId: string, external: string, amount: string, recognised: string, closed = false) =>
      w.as(async (tx) => {
        const connection = await tx.query<{ id: string }>(
          `insert into sales_platform_connections (platform, store_domain, auth_method, webhook_key, connected_by_email, credentials_ciphertext)
           values ('shopify', $1, 'token', $2, 'jade@example.com', 'not-a-real-secret') returning id::text`,
          [`${external}.example.myshopify.com`, `${external}-`.padEnd(40, "k")],
        );
        const income = await tx.query<{ id: string }>("select id::text from accounts where code = '4000'");
        await tx.query(
          `insert into sales_platform_held_lines (connection_id, order_external_id, line_kind, line_external_id, description, income_account_id, held_account_id, quantity, amount, recognised_amount, closed)
           values ($1, $2, 'line', $2, 'Paw print pendant', $3, $4, 1, $5::numeric, $6::numeric, $7)`,
          [connection.rows[0].id, external, income.rows[0].id, accountId, amount, recognised, closed],
        );
      });
    await holdLine(held.id, "order-1", "400.00", "50.00");
    await holdLine(held.id, "order-2", "999.00", "999.00", true);
    await holdLine(other, "order-3", "80.00", "0.00");
    const sheet = await w.worksheet();
    expect(sheet.shopHeld).toEqual([
      { account: { id: held.id, code: held.code, name: held.name }, held: "350.00", counted: true },
      { account: { id: other, code: "2590", name: "Deposits held" }, held: "80.00", counted: false },
    ]);
    expect(await w.tie("income_in_advance")).toMatchObject({ worksheet: "2750.00", ledger: "2750.00", difference: "0.00" });
  });

  it("SW23: books kept elsewhere: the month's journal and the worksheet as files, and items brought in from one", async () => {
    const w = await setup();
    expect((await w.worksheet()).booksElsewhere).toBe(false);
    await w.as((tx) => saveSpreadingSettings(tx, { booksElsewhere: true }));
    // Saving the accounts again leaves the choice alone.
    await w.as((tx) => saveSpreadingSettings(tx, {}));
    expect((await w.worksheet()).booksElsewhere).toBe(true);

    const csv = ["Kind,What,Amount,Account code,How,From,To,Month", "Paid in advance,Farm insurance,1200.00,6080,Evenly by month,1/7/2026,30/6/2027,", "income in advance,Event deposit,500,4000,All in one month,,,2027-03", ",,,,,,,"].join("\r\n");
    const importKey = key("import");
    expect(await w.asAroha((tx) => importSpreadItems(tx, { idempotencyKey: importKey, csv }))).toEqual({ added: 2 });
    // The same file again adds nothing.
    expect(await w.asAroha((tx) => importSpreadItems(tx, { idempotencyKey: importKey, csv }))).toEqual({ added: 0 });
    const items = (await w.worksheet()).items;
    expect(items.map((item) => [item.kind, item.description, item.amount, item.months.length])).toEqual([
      ["prepayment", "Farm insurance", "1200.00", 12],
      ["income_in_advance", "Event deposit", "500.00", 1],
    ]);
    // One bad row and none are added.
    const bad = ["Kind,What,Amount,Account code,How,From,To,Month", "Paid in advance,Levy,100,6080,Evenly by month,2026-07-01,2026-12-31,", "Paid in advance,Oops,100,9999,All in one month,,,2026-08"].join("\n");
    await expect(w.asAroha((tx) => importSpreadItems(tx, { idempotencyKey: key("import"), csv: bad }))).rejects.toThrow("Row 3: There's no account 9999.");
    expect((await w.worksheet()).items).toHaveLength(2);
    await expect(w.asAroha((tx) => importSpreadItems(tx, { idempotencyKey: key("import"), csv: "What,Amount\nA,1" }))).rejects.toThrow(/Missing: Kind, Account code/);

    // July's journal before and after posting is the same two rows.
    const expected = "Date,Reference,Description,Account code,Account name,Debit,Credit\r\n2026-07-31,SPREAD-PAID-2026-07,Farm insurance - July 2026,6080,Insurance,100.00,\r\n2026-07-31,SPREAD-PAID-2026-07,Farm insurance - July 2026,1200,Prepayments,,100.00\r\n";
    const before = await w.as((tx) => monthJournalFile(tx, "prepayment", "2026-07"));
    expect(before).toEqual({ fileName: "spreading-paid-in-advance-2026-07.csv", csv: expected });
    await w.post("prepayment", "2026-07");
    expect((await w.as((tx) => monthJournalFile(tx, "prepayment", "2026-07"))).csv).toBe(expected);
    const sheet = await w.as((tx) => worksheetFile(tx, "prepayment"));
    const lines = sheet.csv.trim().split("\r\n");
    expect(lines[0]).toBe("What,Account code,Account name,How,From,To,Amount,Left,2026-07,2026-08,2026-09,2026-10,2026-11,2026-12,2027-01,2027-02,2027-03,2027-04,2027-05,2027-06");
    expect(lines[1]).toBe(`Farm insurance,6080,Insurance,Evenly by month,2026-07-01,2027-06-30,1200.00,1100.00,${Array(12).fill("100.00").join(",")}`);
  });

  it("SW24: what's behind an Out by: entries from outside the worksheet beside what the worksheet expects", async () => {
    const w = await setup();
    await w.insurance();
    for (const month of ["2026-07", "2026-08", "2026-09"]) await w.post("prepayment", month);
    await w.journal("2026-09-30", "ODD", [
      ["1200", "50.00", "0"],
      ["6080", "0", "50.00"],
    ]);
    // A voided entry and its reversal are left off.
    const stray = await w.journal("2026-09-15", "MISTAKE", [
      ["1200", "75.00", "0"],
      ["6080", "0", "75.00"],
    ]);
    await w.as(async (tx) => {
      const plan = await planVoidJournals(tx, { journalIds: [stray.journal.id] });
      await voidJournals(tx, { idempotencyKey: key("void"), journalIds: [stray.journal.id], reason: "Entered twice", previewHash: plan.hash });
    });
    // One made with Spread this is on neither list.
    const bank = (await w.as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const supplier = (await w.as((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Licensing NZ", isSupplier: true }))).contact;
    const spend = (await w.as((tx) => createBankTransaction(tx, { idempotencyKey: key("spend"), kind: "spend", accountId: bank.id, contactId: supplier.id, date: "2026-10-01", amountsMode: "no_tax", lines: [{ description: "Licence", accountCode: "6080", amount: "240.00" }] }))).bankTransaction;
    const [line] = await w.as((tx) => listSourceLines(tx, "bank", spend.id));
    await w.add({ bankLineId: line.lineId, startDate: "2026-10-01", endDate: "2027-09-30" });

    const explain = await w.as((tx) => explainSpreadDifference(tx, "prepayment"));
    expect(explain.outside.map((row) => [row.date, row.reference, row.amount])).toEqual([
      ["2026-09-30", "ODD", "50.00"],
      ["2026-07-01", "INS-BILL", "1200.00"],
    ]);
    expect(explain.expected.map((row) => [row.description, row.amount])).toEqual([["Farm insurance", "1200.00"]]);
    expect(explain).toMatchObject({ outsideTotal: "1250.00", expectedTotal: "1200.00", difference: "50.00", outsideMore: 0 });
    expect((await w.tie("prepayment")).difference).toBe(explain.difference);
  });

  it("SW24: for an accrual, the bills marked by hand are what's expected", async () => {
    const w = await setup();
    const held = w.settings.accrued_expense!.code;
    await w.as((tx) => createAccount(tx, { code: "6470", name: "Rates", accountType: "expense" }));
    const rates = await w.add({ kind: "accrued_expense", description: "Rates", targetAccountCode: "6470", amount: "900.00", startDate: "2026-07-01", endDate: "2026-09-30" });
    for (const month of ["2026-07", "2026-08", "2026-09"]) await w.post("accrued_expense", month);
    await w.asAroha((tx) => settleSpreadItem(tx, rates.id, { month: "2026-10", amount: "920.00" }));
    // The bill hasn't been coded to the account yet: out by its 920.00.
    const before = await w.as((tx) => explainSpreadDifference(tx, "accrued_expense"));
    expect(before).toMatchObject({ outside: [], expected: [{ itemId: rates.id, description: "Rates: its bill", amount: "-920.00" }], difference: "920.00" });
    expect((await w.tie("accrued_expense")).difference).toBe("920.00");
    await w.journal("2026-10-05", "RATES-BILL", [
      [held, "920.00", "0"],
      ["2000", "0", "920.00"],
    ]);
    const after = await w.as((tx) => explainSpreadDifference(tx, "accrued_expense"));
    expect(after).toMatchObject({ outsideTotal: "-920.00", expectedTotal: "-920.00", difference: "0.00" });
    expect((await w.tie("accrued_expense")).difference).toBe("0.00");
  });

  it("the AI tools do what the screen does, and the undos confirm first", async () => {
    const w = await setup();
    const token = async (accessLevel: "post" | "full") => {
      const response = await tokensRoute.POST(
        apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: w.org, name: accessLevel, accessLevel, ...(accessLevel === "full" ? { confirmFullAccess: true } : {}) } }),
        noContext,
      );
      expect(response.status).toBe(201);
      return ((await response.json()) as { token: string }).token;
    };
    let rpcId = 0;
    const call = async (bearer: string, name: string, args: Record<string, unknown> = {}) => {
      rpcId += 1;
      const response = await mcpRoute.POST(
        new Request("http://tohyee.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } }) }),
        noContext,
      );
      const body = (await response.json()) as { error?: { message: string }; result?: { content: { text: string }[]; isError?: boolean } };
      if (body.error) throw new Error(body.error.message);
      if (body.result!.isError) throw new Error(body.result!.content[0].text);
      return JSON.parse(body.result!.content[0].text) as Record<string, unknown>;
    };
    const post = await token("post");
    const full = await token("full");
    await w.journal("2026-07-01", "INS-BILL", [
      ["1200", "1200.00", "0"],
      ["2000", "0", "1200.00"],
    ]);
    const args = { kind: "prepayment", description: "Farm insurance", amount: "1200.00", targetAccountCode: "6080", startDate: "2026-07-01", endDate: "2027-06-30", idempotencyKey: "ai-spread-item-1" };
    const made = (await call(post, "add_spreading_item", args)) as { created: boolean; item: { id: string } };
    expect(made.created).toBe(true);
    expect(await call(post, "add_spreading_item", args)).toMatchObject({ created: false, item: { id: made.item.id } });
    expect(await call(post, "preview_spreading_month", { kind: "prepayment", month: "2026-07" })).toMatchObject({ total: "100.00", blocked: null });
    const july = (await call(post, "post_spreading_month", { kind: "prepayment", month: "2026-07", idempotencyKey: "ai-spread-month-1" })) as { run: { id: string } };
    const sheet = (await call(post, "get_spreading_worksheet")) as { tieOut: Array<{ kind: string; difference: string }>; posted: { prepayment: { runId: string } } };
    expect(sheet.posted.prepayment.runId).toBe(july.run.id);
    expect(sheet.tieOut.find((row) => row.kind === "prepayment")!.difference).toBe("0.00");
    expect(await call(post, "explain_spreading_difference", { kind: "prepayment" })).toMatchObject({ difference: "0.00" });
    // Undoing is for Full access, and shows what it acts on first.
    await expect(call(post, "undo_spreading_month", { runId: july.run.id })).rejects.toThrow();
    const before = await w.journals();
    const preview = (await call(full, "undo_spreading_month", { runId: july.run.id })) as { preview: boolean; confirmHash: string };
    expect(preview.preview).toBe(true);
    expect(await w.journals()).toBe(before);
    expect(await call(full, "undo_spreading_month", { runId: july.run.id, confirmHash: preview.confirmHash, idempotencyKey: "ai-spread-undo-1" })).toMatchObject({ run: { status: "undone" } });
    const removal = (await call(full, "remove_spreading_item", { itemId: made.item.id })) as { confirmHash: string };
    expect(await call(full, "remove_spreading_item", { itemId: made.item.id, confirmHash: removal.confirmHash, idempotencyKey: "ai-spread-remove-1" })).toEqual({ removed: true });
    expect((await w.worksheet()).items).toEqual([]);
  });

  it("SW25: tracking and custom fields on an item go on each month's income or expense line", async () => {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const department = (await w.as((tx) => getTrackingSetup(tx))).categories.find((c) => c.kind === "department")!.id;
    const values = async (name: string) => (await w.as((tx) => createTrackingValue(tx, { categoryId: department, name }))).categories.find((c) => c.id === department)!.values.find((v) => v.name === name)!.id;
    const farm = await values("Farm");
    const runoff = await values("Runoff");
    const lineSetup = await w.as((tx) => createCustomField(tx, { record: "line", label: "Policy number", type: "text", usedOn: ["journal"] }));
    const policy = lineSetup.fields.find((field) => field.label === "Policy number")!.id;
    const headerSetup = await w.as((tx) => createCustomField(tx, { record: "document", label: "Checked by", type: "text", usedOn: ["journal"] }));
    const checkedBy = headerSetup.fields.find((field) => field.label === "Checked by")!.id;
    await w.journal("2026-07-01", "INS-BILL", [
      ["1200", "2400.00", "0"],
      ["2000", "0", "2400.00"],
    ]);
    const fields = { kind: "prepayment", targetAccountCode: "6080", amount: "1200.00", startDate: "2026-07-01", endDate: "2027-06-30" };
    const tagged = await w.add({ ...fields, description: "Farm insurance", tracking: { [department]: farm }, customFields: { [policy]: "FMG-1" } });
    expect(tagged).toMatchObject({ tracking: { [department]: farm }, customFields: { [policy]: "FMG-1" } });
    const plain = await w.add({ ...fields, description: "Runoff insurance" });
    expect(plain).toMatchObject({ tracking: {}, customFields: {} });
    // A value that isn't the category's, or a field that isn't for journal lines, is refused when it's typed.
    await expect(w.add({ ...fields, description: "Bad", tracking: { [department]: "999999" } })).rejects.toThrow(/isn't a Department value/);
    await expect(w.add({ ...fields, description: "Bad", customFields: { [checkedBy]: "x" } })).rejects.toThrow(/no line custom field/);

    const july = await w.post("prepayment", "2026-07");
    const posted = await w.as((tx) => getJournal(tx, july.journalId as string));
    expect(posted.lines.map((line) => [line.accountCode, line.debitAmount, line.tracking, line.customFields])).toEqual([
      ["6080", "100.00", { [department]: farm }, { [policy]: "FMG-1" }],
      ["1200", "0.00", {}, {}],
      ["6080", "100.00", {}, {}],
      ["1200", "0.00", {}, {}],
    ]);

    // Department becomes a must on income and expense lines: August waits until the item has one, and says which.
    await w.as((tx) => updateTrackingCategory(tx, department, { isRequired: true }));
    const preview = await w.as((tx) => previewSpreadMonth(tx, "prepayment", "2026-08"));
    expect(preview.blocked).toBe("Runoff insurance needs a Department. Set it on the item, then post.");
    const before = await w.journals();
    await expect(w.post("prepayment", "2026-08")).rejects.toThrow("Runoff insurance needs a Department. Set it on the item, then post.");
    expect(await w.journals()).toBe(before);
    const changed = await w.asAroha((tx) => updateSpreadItemTags(tx, plain.id, { tracking: { [department]: runoff } }));
    expect(changed.tracking).toEqual({ [department]: runoff });
    expect((await w.as((tx) => previewSpreadMonth(tx, "prepayment", "2026-08"))).blocked).toBeNull();
    // The journal's own custom field is filled in at Month end.
    const august = (await w.asAroha((tx) => postSpreadMonth(tx, { idempotencyKey: key("month"), kind: "prepayment", month: "2026-08", customFields: { [checkedBy]: "Aroha" } }))).run;
    const augustJournal = await w.as((tx) => getJournal(tx, august.journalId as string));
    expect(augustJournal.customFields).toEqual({ [checkedBy]: "Aroha" });
    expect(augustJournal.lines.map((line) => [line.accountCode, line.tracking])).toEqual([
      ["6080", { [department]: farm }],
      ["1200", {}],
      ["6080", { [department]: runoff }],
      ["1200", {}],
    ]);
    // July keeps what it was posted with.
    expect((await w.as((tx) => getJournal(tx, july.journalId as string))).lines[2].tracking).toEqual({});
    // Undoing August reverses it tag for tag, custom fields too (BKF8).
    const undone = await w.undo(august.id);
    const undoJournal = await w.as((tx) => getJournal(tx, undone.undoJournalId as string));
    expect(undoJournal.lines.map((line) => [line.accountCode, line.creditAmount, line.tracking, line.customFields])).toEqual([
      ["6080", "100.00", { [department]: farm }, { [policy]: "FMG-1" }],
      ["1200", "0.00", {}, {}],
      ["6080", "100.00", { [department]: runoff }, {}],
      ["1200", "0.00", {}, {}],
    ]);
    expect(undoJournal.customFields).toEqual({ [checkedBy]: "Aroha" });
  });

  it("the API: viewers read, bookkeepers add and post, admins change the accounts", async () => {
    const w = await setup();
    const asViewer = await sessionCookieFor(viewer);
    const asBookkeeper = await sessionCookieFor(aroha);
    const read = await worksheetRoute.GET(apiRequest(`/api/spreading?organisationId=${w.org}`, { cookie: asViewer }), noContext);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { worksheet: { ready: boolean } }).worksheet.ready).toBe(true);
    const body = { organisationId: w.org, idempotencyKey: key("item"), kind: "prepayment", description: "Insurance", targetAccountCode: "6080", amount: "1200", startDate: "2026-07-01", endDate: "2027-06-30" };
    expect((await itemsRoute.POST(apiRequest("/api/spreading/items", { method: "POST", cookie: asViewer, body }), noContext)).status).toBe(403);
    const made = await itemsRoute.POST(apiRequest("/api/spreading/items", { method: "POST", cookie: asBookkeeper, body }), noContext);
    expect(made.status).toBe(201);
    const itemId = ((await made.json()) as { item: { id: string } }).item.id;
    expect((await settingsRoute.PUT(apiRequest("/api/spreading/settings", { method: "PUT", cookie: asBookkeeper, body: { organisationId: w.org } }), noContext)).status).toBe(403);
    const preview = await worksheetRoute.GET(apiRequest(`/api/spreading?organisationId=${w.org}&kind=prepayment&month=2026-07`, { cookie: asViewer }), noContext);
    expect(((await preview.json()) as { preview: { total: string } }).preview.total).toBe("100.00");
    const posted = await monthsRoute.POST(
      apiRequest("/api/spreading/months", { method: "POST", cookie: asBookkeeper, body: { organisationId: w.org, idempotencyKey: key("month"), kind: "prepayment", month: "2026-07" } }),
      noContext,
    );
    expect(posted.status).toBe(201);
    const runId = ((await posted.json()) as { run: { id: string } }).run.id;
    const undone = await undoRoute.POST(
      apiRequest(`/api/spreading/runs/${runId}/undo`, { method: "POST", cookie: asBookkeeper, body: { organisationId: w.org, idempotencyKey: key("undo") } }),
      { params: Promise.resolve({ runId }) },
    );
    expect(undone.status).toBe(201);
    const removed = await itemRoute.DELETE(apiRequest(`/api/spreading/items/${itemId}?organisationId=${w.org}`, { method: "DELETE", cookie: asBookkeeper }), { params: Promise.resolve({ itemId }) });
    expect(removed.status).toBe(200);
  });
});
