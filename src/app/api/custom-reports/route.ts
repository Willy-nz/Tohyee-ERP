import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createCustomReport, listCustomReports, publishCustomReport } from "@/lib/reports/custom";
import { ValidationError } from "@/lib/errors";

/** GET: custom reports, `view` = drafts (default), published or archived. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const reports = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listCustomReports(tx, params.get("view")));
  return json({ reports });
});

/**
 * Starts a draft as a copy of a standard report (examples CR1, CR6,
 * CR11-CR15). With `publish: true` (Publish on a standard report, CR25) the
 * draft is published in the same step and the published copy is returned,
 * with `draftId`.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  if (body.publish !== undefined && typeof body.publish !== "boolean") throw new ValidationError("publish must be true or false.");
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", async (tx) => {
    const created = await createCustomReport(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      base: body.base,
      periodEnd: body.periodEnd,
      layout: body.layout,
      start: body.start,
      columns: body.columns,
      title: body.title,
    });
    if (!body.publish) return created;
    const published = await publishCustomReport(tx, created.report.id, { source: body.source, idempotencyKey: `${String(body.idempotencyKey)}-publish` });
    return { created: published.created, report: published.report, draftId: created.report.id };
  });
  return json(result, { status: result.created ? 201 : 200 });
});
