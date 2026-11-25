import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import type { OrgTx } from "@/lib/db/org-transaction";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { getOrganisation } from "@/lib/organisations/registry";
import { payoutGuidanceForLine, payoutMatchReport } from "@/lib/sales-platforms/payout-reconcile";
import { createContact } from "@/lib/contacts/service";
import { createTransfer } from "@/lib/bank/transactions";
import { salesPlatformDiagnostics } from "@/lib/sales-platforms/diagnostics";
import { possibleDoublePayouts } from "@/lib/sales-platforms/payout-doubles";
import { connectStore, listSyncLog, syncConnection, testConnection, updateConnectionSettings } from "@/lib/sales-platforms/service";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
import { createTaxCode } from "@/lib/tax/codes";
import { CLIENT_ID, CLIENT_SECRET, fakeShopifyStore, order1001, order1002, payout70001, refund6001, storeState } from "../helpers/fake-shopify-orders";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * SPF3-SPF4 (review H3): a deposit reconciled by hand (SPR9's "transfer out of clearing", offered while
 * the store hasn't given the payout scopes) isn't posted again once the scopes are given: the payout
 * links to the hand-made transfer. A deposit reconciled to something else holds the payout for a
 * person. Payouts already doubled before this are listed, read-only.
 */
const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
const CONNECTED_AT = new Date("2026-10-01T00:03:01Z");

describeWithDatabase("SPF3-SPF4: a payout whose deposit was entered by hand", () => {
  let server: TestServer;
  let owner: SessionUser;
  const savedKey = process.env.TOHYEE_SECRET_KEY;
  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("h3@review.nz", { serverAdmin: true, displayName: "H3" });
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });
  afterEach(() => setSalesPlatformFetchForTests(null));
  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  let organisations = 0;
  async function setup() {
    organisations += 1;
    const org = `h3-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    await as(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await updateOrganisationSettings(tx, { gstNumber: "123-456-789", gstRegistered: true, exportTaxCode: "EXPORT" });
    });
    // The app has no payout scopes yet.
    const state = storeState({ scopes: ["read_customers", "read_products", "read_orders"] });
    setSalesPlatformFetchForTests(fakeShopifyStore(state));
    const record = (await getOrganisation(org))!;
    const connection = await connectStore(
      record,
      actor,
      { platform: "shopify", storeDomain: "glenmore", authMethod: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { webhookOrigin: null, now: CONNECTED_AT },
    );
    await as((tx) =>
      updateConnectionSettings(tx, connection.id, {
        postToAccounts: true,
        startDate: "2026-10-01",
        newClearingAccount: { code: "1010", name: "Money held by Shopify" },
        payoutAccountCode: "1000",
        feesAccountCode: "6020",
        salesAccountCode: "4000",
        shippingAccountCode: "4000",
        taxCodes: [{ rate: "15", taxCode: "GST" }],
        untaxedTaxCode: "ZERO",
      }),
    );
    const sync = (at: string) => syncConnection(record, connection.id, undefined, new Date(at));
    const balance = async (code: string) =>
      (
        await as((tx) =>
          tx.query<{ net: string }>(
            `select to_char(coalesce(sum(l.debit_amount - l.credit_amount), 0), 'FM999999990.00') as net
               from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = $1`,
            [code],
          ),
        )
      ).rows[0].net;
    const bank = (await as((tx) => tx.query<{ id: string }>("select id from accounts where code = '1000'"))).rows[0].id;
    await sync("2026-10-01T01:00:00Z");
    state.orders.push(order1001({ financialStatus: "PARTIALLY_REFUNDED", updatedAt: "2026-10-05T22:00:30Z", refunds: [refund6001()] }), order1002());
    state.payouts.push(payout70001());
    await sync("2026-10-07T04:00:00Z");
    expect(await balance("1010")).toBe("51.90"); // 46.00 + 28.90 - 23.00, waiting for the payout
    const csv = "Date,Amount,Payee\n08/10/2026,49.38,SHOPIFY PAYOUT\n";
    await as((tx) => importStatementFile(tx, bank, { idempotencyKey: key("import"), fileName: "s.csv", fileBase64: Buffer.from(csv).toString("base64") }));
    const [line] = (await as((tx) => listStatementLines(tx, bank, { status: "unreconciled" }))).lines;
    const addScopes = async () => {
      state.scopes.push("read_shopify_payments_payouts", "read_shopify_payments_accounts");
      await testConnection(record, actor, connection.id, { now: new Date("2026-11-01T00:00:00Z") });
      await sync("2026-11-01T01:00:00Z");
    };
    const log = async () => (await as((tx) => listSyncLog(tx, connection.id))).entries;
    return { as, balance, bank, line, addScopes, log, connectionId: connection.id };
  }

  it("SPF3: the payout links to the transfer made by hand, and only its fees are posted", async () => {
    const w = await setup();
    // With no payout scopes Tohyee offers a transfer out of the clearing account (SPR9).
    const guidance = (await w.as((tx) => payoutGuidanceForLine(tx, w.line.id)))!;
    expect(guidance).toMatchObject({ status: "missing_settlement_data", action: { kind: "transfer", otherAccountCode: "1010" } });
    await w.as((tx) => reconcileStatementLine(tx, w.line.id, { idempotencyKey: key("reconcile"), ...guidance.action! }));
    expect(await w.balance("1000")).toBe("49.38");

    await w.addScopes();
    // The bank stays at the statement's 49.38, and the clearing account is cleared by the fees.
    expect(await w.balance("1000")).toBe("49.38");
    expect(await w.balance("1010")).toBe("0.00");
    expect(await w.balance("6020")).toBe("2.52");
    const transfers = (await w.as((tx) => tx.query<{ id: string; amount: string }>("select id::text, amount::text from bank_transfers where status = 'posted' order by id"))).rows;
    expect(transfers.map((t) => t.amount)).toEqual(["49.38"]);
    const doc = (await w.as((tx) => tx.query<{ transfer_id: string }>("select transfer_id::text from sales_platform_documents where record_kind = 'payout' and external_id = '70001'"))).rows[0];
    expect(doc.transfer_id).toBe(transfers[0].id);
    expect((await w.log()).find((entry) => entry.externalId === "70001")?.message).toContain("already in the books");
    expect(await w.as((tx) => possibleDoublePayouts(tx, w.connectionId))).toEqual([]);
  }, 120_000);

  it("SPF3: a deposit reconciled to something else by hand holds the payout for a person", async () => {
    const w = await setup();
    const customer = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Shop takings", isCustomer: true }))).contact;
    await w.as((tx) =>
      reconcileStatementLine(tx, w.line.id, {
        idempotencyKey: key("reconcile"),
        kind: "bank_transaction",
        contactId: customer.id,
        amountsMode: "no_tax",
        lines: [{ description: "Shop takings", accountCode: "4000", amount: "49.38" }],
      }),
    );
    await w.addScopes();
    expect(await w.balance("1000")).toBe("49.38");
    expect((await w.as((tx) => tx.query("select 1 from sales_platform_documents where record_kind = 'payout'"))).rowCount).toBe(0);
    const message = (await w.log()).find((entry) => entry.externalId === "70001")?.message ?? "";
    expect(message).toContain("needs a person");
    expect(message).toContain("SHOPIFY PAYOUT");
  }, 120_000);

  it("SPF4: a payout posted twice before this is listed, read-only, in the status and the log", async () => {
    const w = await setup();
    const guidance = (await w.as((tx) => payoutGuidanceForLine(tx, w.line.id)))!;
    await w.as((tx) => reconcileStatementLine(tx, w.line.id, { idempotencyKey: key("reconcile"), ...guidance.action! }));
    // As the payout was posted before SPF3: its own transfer, beside the hand-made one.
    await w.as(async (tx) => {
      const { transfer } = await createTransfer(tx, {
        source: "sales-platform",
        idempotencyKey: key("old-payout"),
        fromAccountCode: "1010",
        toAccountCode: "1000",
        date: "2026-10-07",
        amount: "49.38",
        reference: "Shopify payout 70001",
      });
      await tx.query(
        `insert into sales_platform_documents (platform, store_domain, record_kind, external_id, connection_id, state, transfer_id)
         select platform, store_domain, 'payout', '70001', id, 'done', $2 from sales_platform_connections where id = $1`,
        [w.connectionId, transfer.id],
      );
    });
    expect(await w.balance("1000")).toBe("98.76");
    const before = await w.balance("1000");
    await w.addScopes();
    const doubles = await w.as((tx) => possibleDoublePayouts(tx, w.connectionId));
    expect(doubles).toEqual([expect.objectContaining({ payoutId: "70001", amount: "49.38", postedOn: "2026-10-07", handTransferDate: "2026-10-08" })]);
    const status = await w.as((tx) => salesPlatformDiagnostics(tx, { connectionId: w.connectionId }));
    const payouts = status.connections[0].imports.payouts as { possibleDoubles?: unknown[]; possibleDoublesNote?: string };
    expect(payouts.possibleDoubles).toHaveLength(1);
    expect(payouts.possibleDoublesNote).toContain("payout 70001");
    expect((await w.log()).some((entry) => entry.message.startsWith("Check this payout"))).toBe(true);
    // Nothing was changed.
    expect(await w.balance("1000")).toBe(before);
  }, 120_000);

  it("SPF12: the payout report's default 'to' date is today in New Zealand, not in UTC", async () => {
    await createTestOrganisation(owner, "spf12-co");
    const actor = { userId: owner.id, email: owner.email };
    vi.useFakeTimers({ toFake: ["Date"] });
    // 9am on 26 Nov in New Zealand is still 25 Nov in UTC.
    vi.setSystemTime(new Date("2026-11-25T20:00:00Z"));
    try {
      const report = await inOrganisation("spf12-co", actor, (tx) => payoutMatchReport(tx));
      expect(report.to).toBe("2026-11-26");
    } finally {
      vi.useRealTimers();
    }
  });
});
