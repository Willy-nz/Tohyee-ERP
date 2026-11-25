import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listBeneficiaryIncome, saveBeneficiaryIncome } from "@/lib/tax/income/beneficiaries";

/** GET: an income year's beneficiary income (`incomeYear`) (TRU3). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const lines = await withOrganisation(request, params.get("organisationId"), "admin", (tx) => listBeneficiaryIncome(tx, Number(params.get("incomeYear"))));
  return json({ lines });
});

/** PUT: `incomeYear` and `lines` [{beneficiaryId, amount, trusteePaysTax, fromMaoriAuthority, otherIncome, taxableDistribution, nonTaxableDistribution, withdrawn, openingBalance}], replacing that year's beneficiary income and distributions (TRU3, TRU18, TRU21, TRU24). */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const lines = await withOrganisation(request, body.organisationId, "admin", (tx) => saveBeneficiaryIncome(tx, { incomeYear: body.incomeYear, lines: body.lines }));
  return json({ lines });
});
