import { json, readJson, route } from "@/lib/api/http";
import { findAiTool } from "@/lib/ai/catalogue";
import { runAiTool } from "@/lib/ai/run-tool";
import { analyticsMember } from "@/lib/analytics/http";
import { ValidationError } from "@/lib/errors";

type Context = { params: Promise<{ dashboardId: string }> };

/**
 * POST { organisationId }: loads the latest data for every source this
 * report's tiles read, now ("Try again" on a report whose refresh failed). Owners and admins, as Refresh now and Load now are on Data
 * sources. It does exactly what the AI's refresh_analytics_sources does, by
 * running that tool as the signed-in person, so the two can't drift apart:
 * it only fetches data again and never changes a connection or a schedule.
 */
export const POST = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  const body = await readJson(request);
  const { organisation, actor, role } = await analyticsMember(request, body.organisationId, "admin");
  const tool = findAiTool("refresh_analytics_sources");
  if (!tool) throw new ValidationError("Refreshing isn't available.");
  const result = await runAiTool(tool, organisation, actor, { role, organisationId: organisation.id, source: "web", accessLevel: "draft", grantedAccessLevel: "draft", organisation, actor }, { dashboardId });
  return json(result);
});
