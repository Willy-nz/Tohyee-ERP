import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { undoSpreadRun } from "@/lib/spreading/runs";

type Context = { params: Promise<{ runId: string }> };

/** Undoes a kind's latest month with the exact reversal on its date (SW14). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { runId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => undoSpreadRun(tx, runId, body));
  return json(result, { status: result.created ? 201 : 200 });
});
