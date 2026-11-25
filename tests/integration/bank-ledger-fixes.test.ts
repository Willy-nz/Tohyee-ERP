import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { getStatementLine, listBankAccounts, listStatementLines, setStatementLineExcluded } from "@/lib/bank/accounts";
import { planRemoveAndRedo, startReconcileBatch, startRemoveAndRedo } from "@/lib/bank/batches";
import { confidentMatches, okConfidentMatches } from "@/lib/bank/confident";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { createBankRule } from "@/lib/bank/rules";
import { createContact } from "@/lib/contacts/service";
import { applyCreditNote } from "@/lib/credit-notes/applications";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import { type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { applyOverpayment } from "@/lib/invoices/overpayments";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { correctJournal, getJournalDetails, postJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { recodeLine } from "@/lib/ledger/recode";
import { getOrganisation } from "@/lib/organisations/registry";
import { bankReconciliationReport } from "@/lib/reports/bank-reconciliation";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Examples BKF1-BKF10 in docs/ACCOUNTING-EXAMPLES.md ("Bank and ledger fixes"). */
describeWithDatabase("bank and ledger fixes (BKF1-BKF10)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("bkf-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function world() {
    organisations += 1;
    const org = `bkf-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const sql = async (text: string, values: unknown[] = []) => (await as((tx) => tx.query(text, values))).rows as Array<Record<string, unknown>>;
    const koru = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Koru Ltd", isCustomer: true, isSupplier: true }))).contact;
    const bank = (await as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const invoice = async (amount = "100.00") => {
      const draft = (
        await as((tx) =>
          createInvoice(tx, {
            idempotencyKey: key("i"),
            contactId: koru.id,
            invoiceDate: "2026-05-10",
            dueDate: "2026-05-20",
            amountsMode: "exclusive",
            lines: [{ description: "Work", quantity: "1", unitPrice: amount, accountCode: "4000", taxCode: "GST" }],
          }),
        )
      ).invoice;
      return (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }))).invoice;
    };
    let files = 0;
    const importFile = async (text: string, name?: string) => {
      files += 1;
      return as((tx) => importStatementFile(tx, bank.id, { idempotencyKey: key("imp"), fileName: name ?? `f${files}.csv`, fileBase64: Buffer.from(text).toString("base64") }));
    };
    const lines = async () => (await as((tx) => listStatementLines(tx, bank.id, { status: "all", limit: 500 }))).lines;
    const runner = async () => {
      const organisation = (await getOrganisation(org))!;
      return <T>(work: (tx: OrgTx) => Promise<T>) => withOrganisationTransaction(organisation, { userId: owner.id, email: owner.email }, work);
    };
    const bankBalance = async () =>
      (await sql("select coalesce(sum(l.debit_amount - l.credit_amount), 0)::numeric(18,2)::text as b from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = '1000'"))[0].b;
    return { org, as, sql, koru, bank, invoice, importFile, lines, runner, bankBalance };
  }

  /** A card purchase from an OFX file, then the same purchase again from a CSV: flagged as a possible duplicate (BK3). */
  async function duplicated(w: Awaited<ReturnType<typeof world>>) {
    const fuel = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Fuel", isSupplier: true }))).contact;
    await w.as((tx) =>
      createBankRule(tx, { name: "Fuel", matchText: "harbour fuel", direction: "out", targetAccountCode: "6120", taxCode: "GST", amountsMode: "inclusive", contactMode: "chosen", contactId: fuel.id } as never),
    );
    await w.importFile(`OFXHEADER:100\n<OFX><BANKTRANLIST>\n<STMTTRN><DTPOSTED>20260521<TRNAMT>-46.00<FITID>A2<NAME>HARBOUR FUEL\n</BANKTRANLIST></OFX>`, "s.ofx");
    await w.importFile("Date,Amount,Payee\n21/05/2026,-46.00,HARBOUR FUEL\n");
    const all = await w.lines();
    const copy = all.find((line) => line.possibleDuplicateOf)!;
    const first = all.find((line) => line.id === copy.possibleDuplicateOf)!;
    return { first, copy };
  }

  it("BKF1: OK all confident matches leaves a possible duplicate for a person; an AI batch refuses it", async () => {
    const w = await world();
    const { first, copy } = await duplicated(w);
    const confidence = await w.as((tx) => confidentMatches(tx, w.bank.id));
    expect(confidence.find((entry) => entry.lineId === copy.id)).toMatchObject({ suggestion: null, possibleDuplicate: true });
    expect(confidence.find((entry) => entry.lineId === first.id)?.suggestion?.kind).toBe("rule");

    // An AI's batch refuses the copy too.
    const batch = await startReconcileBatch(await w.runner(), { actions: [{ action: "apply_bank_rule", lineId: copy.id }], idempotencyKey: key("batch"), source: "ai-test" });
    expect(batch.batch.actions[0]).toMatchObject({ status: "failed" });
    expect(batch.batch.actions[0].error).toContain("may be a duplicate");

    const result = await okConfidentMatches(await w.runner(), w.bank.id, { idempotencyKey: key("okall") });
    expect([result.succeeded, result.failed]).toEqual([1, 0]);
    const spends = await w.sql("select count(*)::text as n, sum(total)::text as t from bank_transactions where status = 'posted'");
    expect(spends[0]).toEqual({ n: "1", t: "46.00" });
    expect((await w.as((tx) => getStatementLine(tx, copy.id))).status).toBe("unreconciled");

    // Once the person excludes it, it's gone from the list; nothing was posted for it.
    await w.as((tx) => setStatementLineExcluded(tx, copy.id, true));
    expect((await w.as((tx) => confidentMatches(tx, w.bank.id))).length).toBe(0);
  });

  it("BKF2: paying an invoice that's already paid from a bank line is refused, unless the extra is kept as an overpayment", async () => {
    const w = await world();
    const inv = await w.invoice(); // 115.00
    await w.as((tx) => recordPayment(tx, inv.id, { idempotencyKey: key("p"), paymentDate: "2026-05-20", amount: "115.00", bankAccountCode: "1000" }));
    await w.importFile("Date,Amount,Payee\n20/05/2026,115.00,KORU LTD\n21/05/2026,115.00,KORU LTD\n");
    const [line, second] = (await w.lines()).sort((a, b) => a.date.localeCompare(b.date));
    await expect(
      w.as((tx) => reconcileStatementLine(tx, line.id, { idempotencyKey: key("rec"), kind: "payments", allocations: [{ invoiceId: inv.id, amount: "115.00" }] })),
    ).rejects.toThrow(`Invoice ${inv.invoiceNumber} is already paid`);
    expect(await w.sql("select count(*)::text as n from customer_payments")).toEqual([{ n: "1" }]);
    expect(await w.bankBalance()).toBe("115.00");

    // Part paid: only what's owing.
    const other = await w.invoice(); // 115.00
    await w.as((tx) => recordPayment(tx, other.id, { idempotencyKey: key("p"), paymentDate: "2026-05-20", amount: "100.00", bankAccountCode: "1000" }));
    await expect(
      w.as((tx) => reconcileStatementLine(tx, line.id, { idempotencyKey: key("rec"), kind: "payments", allocations: [{ invoiceId: other.id, amount: "115.00" }] })),
    ).rejects.toThrow(`only owed 15.00, but 115.00 is set against it`);

    // Chosen on purpose: the customer really paid twice.
    const done = await w.as((tx) =>
      reconcileStatementLine(tx, second.id, { idempotencyKey: key("rec"), kind: "payments", allocations: [{ invoiceId: inv.id, amount: "115.00" }], allowOverpayment: true }),
    );
    expect(done.line.status).toBe("reconciled");
    expect(await w.sql("select amount::text, overpayment_amount::text from customer_payments where invoice_id = $1 order by id", [inv.id])).toEqual([
      { amount: "115.00", overpayment_amount: "0.00" },
      { amount: "115.00", overpayment_amount: "115.00" },
    ]);

    // BKF10: the bank reconciliation report lists it under "worth checking".
    const report = await w.as((tx) => bankReconciliationReport(tx, { accountId: w.bank.id, asAt: "2026-05-31" }));
    expect(report.worthChecking.paidAgain).toEqual([
      expect.objectContaining({ invoiceId: inv.id, date: "2026-05-21", amount: "115.00", overpayment: "115.00" }),
    ]);
    expect(report.worthChecking.duplicates).toEqual([]);
  });

  it("BKF3: Remove & redo voids the adjustment the line posted, so redoing it doesn't post it twice", async () => {
    const w = await world();
    const inv = await w.invoice(); // 115.00
    await w.as((tx) => recordPayment(tx, inv.id, { idempotencyKey: key("p"), paymentDate: "2026-05-20", amount: "115.00", bankAccountCode: "1000" }));
    await w.importFile("Date,Amount,Payee\n20/05/2026,112.50,KORU LTD\n");
    const line = (await w.lines())[0];
    const paymentLine = (
      await w.sql(
        "select l.id::text from ledger_journal_lines l join accounts a on a.id = l.account_id join ledger_journals j on j.id = l.journal_id where a.code = '1000' and j.origin = 'customer_payment'",
      )
    )[0].id;
    const match = () =>
      w.as((tx) =>
        reconcileStatementLine(tx, line.id, { idempotencyKey: key("rec"), kind: "match", journalLineIds: [paymentLine], adjustment: { accountCode: "6020", description: "Bank fee", contactId: w.koru.id } }),
      );
    await match();
    expect(await w.bankBalance()).toBe("112.50");
    const plan = await w.as((tx) => planRemoveAndRedo(tx, [line.id], { removePayments: false }));
    expect(plan.items[0].voids).toMatchObject({ kind: "bank_transaction", date: "2026-05-20" });
    await startRemoveAndRedo(await w.runner(), { lineIds: [line.id], removePayments: false, previewHash: plan.hash, idempotencyKey: key("redo"), source: "ui" });
    expect((await w.as((tx) => getStatementLine(tx, line.id))).status).toBe("unreconciled");
    expect(await w.sql("select status from bank_transactions order by id")).toEqual([{ status: "voided" }]);
    expect(await w.bankBalance()).toBe("115.00");
    // Redone the same way: one 2.50 fee, and the ledger agrees with the statement.
    await match();
    expect(await w.bankBalance()).toBe("112.50");
    expect(await w.sql("select status from bank_transactions order by id")).toEqual([{ status: "voided" }, { status: "posted" }]);
  });

  it("BKF4: Edit this journal is only for manual journals: a recode is refused, a manual one and its replacement still work", async () => {
    const w = await world();
    const inv = await w.invoice();
    await w.as((tx) => recodeLine(tx, { idempotencyKey: key("r"), documentType: "invoice", documentId: inv.id, lineOrder: 1, accountCode: "4100", reason: "Wrong account" }));
    const recode = (await w.sql("select id::text from ledger_journals where origin = 'recode'"))[0].id as string;
    expect((await w.as((tx) => getJournalDetails(tx, recode))).canCorrect).toBe(false);
    const lines = [
      { accountCode: "4200", debitAmount: "100.00" },
      { accountCode: "4000", creditAmount: "100.00" },
    ];
    await expect(
      w.as((tx) => correctJournal(tx, { idempotencyKey: key("cj"), originalJournalId: recode, postingDate: "2026-05-10", reference: "Edited", lines })),
    ).rejects.toThrow("recode the line on its document");
    expect((await w.as((tx) => getInvoice(tx, inv.id))).lines[0].accountCode).toBe("4100");

    const manual = (await w.as((tx) => postJournal(tx, { idempotencyKey: key("j"), postingDate: "2026-05-10", reference: "Accrual", lines })) as { journal: { id: string } }).journal.id;
    expect((await w.as((tx) => getJournalDetails(tx, manual))).canCorrect).toBe(true);
    const fixed = await w.as((tx) => correctJournal(tx, { idempotencyKey: key("cj"), originalJournalId: manual, postingDate: "2026-05-11", reference: "Accrual v2", lines }));
    expect((await w.as((tx) => getJournalDetails(tx, fixed.replacementJournal.id))).canCorrect).toBe(true);
    await w.as((tx) => correctJournal(tx, { idempotencyKey: key("cj"), originalJournalId: fixed.replacementJournal.id, postingDate: "2026-05-12", reference: "Accrual v3", lines }));
  });

  it("BKF5: a credit note application can't commit into a period closed while it ran", async () => {
    const w = await world();
    const inv = await w.invoice();
    const note = (
      await w.as((tx) =>
        createCreditNote(tx, {
          idempotencyKey: key("cn"),
          contactId: w.koru.id,
          creditNoteDate: "2026-05-15",
          amountsMode: "exclusive",
          lines: [{ description: "Discount", quantity: "1", unitPrice: "20.00", accountCode: "4000", taxCode: "GST" }],
        }),
      )
    ).creditNote;
    await w.as((tx) => approveCreditNote(tx, note.id, { idempotencyKey: key("ap") }));
    let release!: () => void;
    const closed = new Promise<void>((resolve) => (release = resolve));
    let checked!: () => void;
    const lockRead = new Promise<void>((resolve) => (checked = resolve));
    const applying = w.as(async (tx) => {
      const paused = {
        ...tx,
        query: (async (text: string, values?: unknown[]) => {
          const result = await tx.query(text, values);
          if (text.includes("from accounting_period_controls")) {
            checked();
            await closed;
          }
          return result;
        }) as OrgTx["query"],
      } as OrgTx;
      return applyCreditNote(paused, note.id, { idempotencyKey: key("apply"), applicationDate: "2026-05-20", applications: [{ invoiceId: inv.id, amount: "23.00" }] });
    });
    await lockRead;
    // The close waits for the application (it holds the lock date row), so let the application go first.
    let closedFirst = false;
    const closing = w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-05-31" })).then(() => (closedFirst = true));
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The close waits: the application holds the lock date row until it commits.
    expect(closedFirst).toBe(false);
    release();
    await applying;
    await closing;
    // So the application went in before May closed, never into a closed May.
    const lock = await w.sql("select lock_date::text as d from accounting_period_controls");
    expect(lock[0].d).toBe("2026-05-31");
    expect(await w.sql("select application_date::text as d, amount::text from sales_credit_note_applications")).toEqual([{ d: "2026-05-20", amount: "23.00" }]);
  });

  it("BKF6: a JPY overpayment is applied in whole yen", async () => {
    const w = await world();
    const yen = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Sakura KK", isCustomer: true, currencyCode: "JPY" }))).contact;
    const make = async () => {
      const draft = (
        await w.as((tx) =>
          createInvoice(
            tx,
            {
              idempotencyKey: key("i"),
              contactId: yen.id,
              invoiceDate: "2026-05-10",
              dueDate: "2026-05-20",
              amountsMode: "no_tax",
              exchangeRate: "0.011",
              lines: [{ description: "Goods", quantity: "1", unitPrice: "1000", accountCode: "4000" }],
            },
            { foreignCurrency: true },
          ),
        )
      ).invoice;
      return (await w.as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }))).invoice;
    };
    const a = await make();
    const b = await make();
    const paid = await w.as((tx) => recordPayment(tx, a.id, { idempotencyKey: key("p"), paymentDate: "2026-05-20", amount: "1500", bankAccountCode: "1000", exchangeRate: "0.011" }));
    const paymentId = (paid as { payment: { id: string } }).payment.id;
    await expect(
      w.as((tx) => applyOverpayment(tx, paymentId, { idempotencyKey: key("ap"), applicationDate: "2026-05-21", applications: [{ invoiceId: b.id, amount: "0.50" }] })),
    ).rejects.toThrow("Application 1 amount must be a whole number.");
    await w.as((tx) => applyOverpayment(tx, paymentId, { idempotencyKey: key("ap"), applicationDate: "2026-05-21", applications: [{ invoiceId: b.id, amount: "500" }] }));
    expect((await w.as((tx) => getInvoice(tx, b.id))).amountDue).toBe("500");
  });

  it("BKF7: a line dated in a locked period can't be excluded or included again", async () => {
    const w = await world();
    await w.importFile("Date,Amount,Payee\n20/05/2026,-12.00,CAFE\n20/06/2026,-8.00,CAFE\n");
    const [may, june] = (await w.lines()).sort((x, y) => x.date.localeCompare(y.date));
    await w.as((tx) => setStatementLineExcluded(tx, may.id, true));
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-05-31" }));
    await expect(w.as((tx) => setStatementLineExcluded(tx, may.id, false))).rejects.toThrow("2026-05-20 is in a locked period");
    await expect(w.as((tx) => setStatementLineExcluded(tx, may.id, true))).resolves.toMatchObject({ status: "excluded" });
    await expect(w.as((tx) => setStatementLineExcluded(tx, june.id, true))).resolves.toMatchObject({ status: "excluded" });
  });

  it("BKF10: a possible duplicate reconciled as well as its line is listed as worth checking", async () => {
    const w = await world();
    const { first, copy } = await duplicated(w);
    const code = (id: string) =>
      w.as((tx) =>
        reconcileStatementLine(tx, id, { idempotencyKey: key("rec"), kind: "bank_transaction", contactId: w.koru.id, amountsMode: "inclusive", lines: [{ description: "Fuel", accountCode: "6120", taxCode: "GST", amount: "46.00" }] }),
      );
    await code(first.id);
    await code(copy.id); // by hand: a person can still say it isn't a duplicate
    const report = await w.as((tx) => bankReconciliationReport(tx, { accountId: w.bank.id, asAt: "2026-05-31" }));
    expect(report.worthChecking.duplicates).toEqual([expect.objectContaining({ lineId: copy.id, duplicateOfLineId: first.id, amount: "-46.00" })]);
  });
});
