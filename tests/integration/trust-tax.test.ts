import { afterAll, beforeAll, expect, it } from "vitest";
import * as beneficiariesRoute from "@/app/api/income-tax/beneficiaries/route";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import { saveBusinessStructure } from "@/lib/organisations/entity";
import { addBeneficiary, deleteBeneficiary, listBeneficiaryIncome, saveBeneficiaryIncome, updateBeneficiary } from "@/lib/tax/income/beneficiaries";
import { buildIncomeTax, getIncomeTaxSettings, getIncomeTaxYear, saveIncomeTaxYear, updateIncomeTaxSettings } from "@/lib/tax/income/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/** Income tax for trusts (TRT1-TRT27, following common practice, not yet reviewed). A made-up trust. */
describeWithDatabase("income tax for trusts", () => {
  let server: TestServer;
  let owner: SessionUser;
  const org = "totara-family-trust";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email, role: "owner" }, work);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("trust-owner@example.com");
    await createTestOrganisation(owner, org);
    await as((tx) => createAccount(tx, { code: "4500", name: "Rent received", accountType: "revenue" }));
    // $60,000 of rent in the 2026 income year (TRT9).
    await as((tx) =>
      postJournal(tx, { idempotencyKey: key("rent"), postingDate: "2025-12-31", reference: "Rent", lines: [{ accountCode: "1000", debitAmount: "60000.00" }, { accountCode: "4500", creditAmount: "60000.00" }] }),
    );
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("TRT1: a trust in Settings makes the workpaper a trust's, with a kind of trust", async () => {
    await as((tx) => saveBusinessStructure(tx, { entityType: "trust", irdNumber: null }));
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    expect(settings).toMatchObject({ taxpayerType: "trust", trustKind: "family", dateOfDeath: null, unsupported: null });
    const estate = await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "trust", agentExtension: false, version: settings.version, trustKind: "deceased_estate", dateOfDeath: "2023-12-30" }));
    expect(estate).toMatchObject({ trustKind: "deceased_estate", dateOfDeath: "2023-12-30" });
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "trust", agentExtension: false, version: estate.version, trustKind: "family" }));
    expect(await as((tx) => getIncomeTaxSettings(tx))).toMatchObject({ trustKind: "family", dateOfDeath: null });
  });

  it("TRT2: beneficiaries, and one with income is archived rather than deleted", async () => {
    const cookie = await sessionCookieFor(owner);
    const created = await beneficiariesRoute.POST(
      apiRequest("/api/income-tax/beneficiaries", { method: "POST", cookie, body: { organisationId: org, name: "Aroha", kind: "person", dateOfBirth: "1990-05-01" } }),
      undefined as never,
    );
    expect(created.status).toBe(201);
    ids.aroha = ((await created.json()) as { beneficiary: { id: string } }).beneficiary.id;
    ids.nikau = (await as((tx) => addBeneficiary(tx, { name: "Nikau", kind: "person", dateOfBirth: "2016-08-01" }))).id;
    ids.tama = (await as((tx) => addBeneficiary(tx, { name: "Tama", kind: "person", dateOfBirth: "2013-06-01" }))).id;
    const company = await as((tx) => addBeneficiary(tx, { name: "Tōtara Holdings Ltd", kind: "company", dateOfBirth: "2000-01-01" }));
    expect(company).toMatchObject({ kind: "company", dateOfBirth: null, corporateRule: true });
    ids.company = company.id;
    const spare = await as((tx) => addBeneficiary(tx, { name: "Spare", kind: "person" }));
    await as((tx) => deleteBeneficiary(tx, spare.id));
  });

  it("TRT3, TRT9: beneficiary income gives the worked example's tax", async () => {
    await expect(as((tx) => saveBeneficiaryIncome(tx, { incomeYear: 2026, lines: [{ beneficiaryId: ids.aroha, amount: "-5" }] }))).rejects.toThrow("can't be negative");
    await as((tx) =>
      saveBeneficiaryIncome(tx, {
        incomeYear: 2026,
        lines: [
          { beneficiaryId: ids.aroha, amount: "20000" },
          { beneficiaryId: ids.nikau, amount: "3000" },
          { beneficiaryId: ids.tama, amount: "800" },
          { beneficiaryId: ids.company, amount: "10000" },
        ],
      }),
    );
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-11-20" }));
    if (!report.supported) throw new Error(report.reason);
    expect(report.workpaper.trust).toMatchObject({
      netIncome: "60000.00",
      ordinaryBeneficiaryIncome: "20800.00",
      minorCorporateIncome: "13000.00",
      minorCorporateTax: "5070.00",
      trusteeIncome: "26200.00",
      trusteeRate: "0.39",
      trusteeTax: "10218.00",
      tax: "15288.00",
    });
    expect(report.workpaper).toMatchObject({ taxableIncome: "26200.00", tax: "15288.00", rit: "15288.00" });
    // TRT14, TRT26: the IR6 figures once the year has ended, with the 2026 form's numbers.
    const boxes = Object.fromEntries(report.ir6!.boxes.map((box) => [box.box, box.amount]));
    expect(report.ir6!.form).toBe(2026);
    expect(boxes).toMatchObject({ "20A": "20800.00", "20C": "13000.00", "27A": "26200.00", "27B": "10218.00", "27C": "5070.00", "27D": "15288.00", "28C": "15288.00" });
    expect(report.ir6!.beneficiaries).toHaveLength(4);
  });

  it("TRT15, TRT18, TRT25: the trust's credits are shared, and the trust pays Aroha's tax", async () => {
    const before = await as((tx) => getIncomeTaxYear(tx, 2026));
    await as((tx) => saveIncomeTaxYear(tx, { incomeYear: 2026, taxCredits: "600", imputationCredits: "1200", overseasTaxPaid: "300", version: before.version }));
    await expect(as((tx) => updateBeneficiary(tx, ids.aroha, { irdNumber: "49-091-851" }))).rejects.toThrow();
    expect(await as((tx) => updateBeneficiary(tx, ids.aroha, { irdNumber: "49-091-850" }))).toMatchObject({ irdNumber: "049091850" });
    await as((tx) =>
      saveBeneficiaryIncome(tx, {
        incomeYear: 2026,
        lines: [
          { beneficiaryId: ids.aroha, amount: "20000", trusteePaysTax: true, otherIncome: "50000", withdrawn: "18000" },
          { beneficiaryId: ids.nikau, amount: "3000" },
          { beneficiaryId: ids.tama, amount: "800" },
          { beneficiaryId: ids.company, amount: "10000" },
        ],
      }),
    );
    const report = await as((tx) => buildIncomeTax(tx, { incomeYear: 2026, today: "2026-11-20" }));
    if (!report.supported) throw new Error(report.reason);
    expect(report.workpaper.trustReturn!.trusteeCredits).toEqual({ overseas: "196.00", imputation: "784.00", other: "392.00" });
    expect(report.workpaper).toMatchObject({ overseasTaxPaid: "196.00", imputationCredits: "784.00", taxCredits: "392.00", rit: "16993.29" });
    const aroha = report.ir6!.beneficiaries.find((entry) => entry.beneficiaryId === ids.aroha)!;
    expect(aroha.irdNumber).toBe("049091850");
    expect(Object.fromEntries(aroha.boxes.map((box) => [box.box, box.amount]))).toMatchObject({ "26I": "20000.00", "26L": "3777.29", "26T": "3077.29", "26Y": "2000.00" });
  });

  it("TRT20-TRT22, TRT24: a non-complying trust's distributions, and the current account carried into the next year", async () => {
    const settings = await as((tx) => getIncomeTaxSettings(tx));
    await expect(as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "trust", agentExtension: false, version: settings.version, trustClass: "offshore" }))).rejects.toThrow();
    expect(await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "trust", agentExtension: false, version: settings.version, trustClass: "non_complying" }))).toMatchObject({ trustClass: "non_complying" });
    await as((tx) => saveBeneficiaryIncome(tx, { incomeYear: 2027, lines: [{ beneficiaryId: ids.aroha, taxableDistribution: "1000", nonTaxableDistribution: "500" }] }));
    const next = await as((tx) => buildIncomeTax(tx, { incomeYear: 2027, today: "2026-11-20" }));
    if (!next.supported) throw new Error(next.reason);
    const aroha = next.workpaper.trustReturn!.statements.find((entry) => entry.beneficiaryId === ids.aroha)!;
    expect(aroha).toMatchObject({ nonComplyingDistribution: "1000.00", nonComplyingTax: "450.00", taxPayable: "450.00" });
    // 2026's closing balance of 2,000 is 2027's opening balance.
    expect(aroha.account).toEqual({ opening: "2000.00", taxable: "1000.00", nonTaxable: "500.00", withdrawn: "0.00", closing: "3500.00" });
    const reset = await as((tx) => getIncomeTaxSettings(tx));
    await as((tx) => updateIncomeTaxSettings(tx, { taxpayerType: "trust", agentExtension: false, version: reset.version, trustClass: "complying" }));
    await as((tx) => saveBeneficiaryIncome(tx, { incomeYear: 2027, lines: [] }));
  });

  it("TRT2: a beneficiary with income can't be deleted, only archived", async () => {
    await expect(as((tx) => deleteBeneficiary(tx, ids.tama))).rejects.toThrow("can be archived but not deleted");
    expect(await as((tx) => updateBeneficiary(tx, ids.tama, { archived: true }))).toMatchObject({ archived: true });
    // Saving the year again with a blank amount removes it.
    await as((tx) => saveBeneficiaryIncome(tx, { incomeYear: 2026, lines: [{ beneficiaryId: ids.aroha, amount: "20000" }, { beneficiaryId: ids.tama, amount: "" }] }));
    expect(await as((tx) => listBeneficiaryIncome(tx, 2026))).toEqual([
      { beneficiaryId: ids.aroha, amount: "20000.00", trusteePaysTax: false, otherIncome: "0.00", taxableDistribution: "0.00", nonTaxableDistribution: "0.00", withdrawn: "0.00", openingBalance: null },
    ]);
  });
});
