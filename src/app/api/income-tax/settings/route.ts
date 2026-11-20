import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateIncomeTaxSettings } from "@/lib/tax/income/service";

/** PUT: company, individual or trust, a tax agent's extension of time, and a trust's kind and date of death (owners and admins; ITX1, ITX10, TRT1, TRT5). */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateIncomeTaxSettings(tx, {
      taxpayerType: body.taxpayerType,
      agentExtension: body.agentExtension,
      version: body.version,
      trustKind: body.trustKind,
      dateOfDeath: body.dateOfDeath,
      trustClass: body.trustClass,
    }),
  );
  return json({ settings });
});
