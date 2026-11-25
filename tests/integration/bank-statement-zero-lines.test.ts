import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { importStatementFile, previewImport } from "@/lib/bank/imports";
import { readStatementFile } from "@/lib/bank/formats";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** SPF11 (review M5): a 0.00 line in an MT940 or CAMT statement is skipped, as OFX and QIF do. */
const MT940 = `:20:STATEMENT
:25:123456789
:28C:1/1
:60F:C260519NZD1000,00
:61:2605200520C115,00NTRFINV-0001//B1
:86:KORU LTD
:61:2605210521D0,00NTRFNONREF//B2
:86:CARD CHECK
:62F:C260522NZD1115,00
-`;

describeWithDatabase("SPF11: zero-amount statement lines", () => {
  let server: TestServer;
  let owner: SessionUser;
  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("zero@review.nz", { serverAdmin: true, displayName: "Z" });
  });
  afterAll(async () => server?.teardown());

  it("SPF11: an MT940 0,00 line is skipped and the statement imports", async () => {
    const parsed = readStatementFile("s.sta", Buffer.from(MT940));
    expect(parsed.lines.map((line) => line.amount)).toEqual(["115.00"]);
    expect(parsed.errors).toEqual([]);
    await createTestOrganisation(owner, "zero-co");
    const actor = { userId: owner.id, email: owner.email };
    const bank = (await inOrganisation("zero-co", actor, (tx) => tx.query<{ id: string }>("select id from accounts where code = '1000'"))).rows[0].id;
    const input = { fileName: "s.sta", fileBase64: Buffer.from(MT940).toString("base64") };
    const preview = await inOrganisation("zero-co", actor, (tx) => previewImport(tx, bank, input));
    expect(preview.newCount).toBe(1);
    await inOrganisation("zero-co", actor, (tx) => importStatementFile(tx, bank, { idempotencyKey: key("i"), ...input }));
    const lines = await inOrganisation("zero-co", actor, (tx) => tx.query<{ amount: string }>("select amount::text from bank_statement_lines where account_id = $1", [bank]));
    expect(lines.rows).toEqual([{ amount: "115.00" }]);
  });

  it("SPF11: a CAMT 0.00 entry is skipped", () => {
    const entry = (amount: string, direction: string, ref: string) =>
      `<Ntry><Amt Ccy="NZD">${amount}</Amt><CdtDbtInd>${direction}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-05-21</Dt></BookgDt><AcctSvcrRef>${ref}</AcctSvcrRef></Ntry>`;
    const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Ccy>NZD</Ccy></Acct>${entry("115.00", "CRDT", "A1")}${entry("0.00", "DBIT", "A2")}</Stmt></BkToCstmrStmt></Document>`;
    const parsed = readStatementFile("s.xml", Buffer.from(camt));
    expect(parsed.lines.map((line) => line.amount)).toEqual(["115.00"]);
    expect(parsed.errors).toEqual([]);
  });
});
