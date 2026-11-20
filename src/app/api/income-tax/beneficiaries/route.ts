import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addBeneficiary, listBeneficiaries } from "@/lib/tax/income/beneficiaries";

/** GET: the trust's beneficiaries (`includeArchived=true` for archived ones too) (TRT2). Owners and admins, as income tax is. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const beneficiaries = await withOrganisation(request, params.get("organisationId"), "admin", (tx) =>
    listBeneficiaries(tx, { includeArchived: params.get("includeArchived") === "true" }),
  );
  return json({ beneficiaries });
});

/** POST: a beneficiary: `name`, `kind` (person or company), `dateOfBirth`, `settledByRelative`, `disabilityAllowance`, `corporateRule` (TRT2). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const beneficiary = await withOrganisation(request, body.organisationId, "admin", (tx) => addBeneficiary(tx, body));
  return json({ beneficiary }, { status: 201 });
});
