import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { campaignReport, listMembers, updateCampaign } from "@/lib/crm/campaigns";

type Context = { params: Promise<{ campaignId: string }> };

/** A campaign's report and members. */
export const GET = route<Context>(async (request, context) => {
  const { campaignId } = await context.params;
  const result = await withCrm(request, searchParams(request).get("organisationId"), "read", async (tx, { scope }) => ({
    report: await campaignReport(tx, campaignId, scope),
    members: await listMembers(tx, { campaignId }, scope),
  }));
  return json(result);
});

/** Changes a campaign, its dates, budget or cost. Admins and owners only. */
export const PATCH = route<Context>(async (request, context) => {
  const { campaignId } = await context.params;
  const body = await readJson(request);
  const campaign = await withCrm(request, body.organisationId, "admin", (tx) =>
    updateCampaign(tx, campaignId, {
      name: body.name,
      kind: body.kind,
      status: body.status,
      startDate: body.startDate,
      endDate: body.endDate,
      budget: body.budget,
      actualCost: body.actualCost,
      description: body.description,
    }),
  );
  return json({ campaign });
});
