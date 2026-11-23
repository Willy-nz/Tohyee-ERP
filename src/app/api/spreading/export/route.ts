import { readJson, route, withOrganisation } from "@/lib/api/http";
import { importTemplateFile, monthJournalFile, worksheetFile } from "@/lib/spreading/files";
import { requireOneOf } from "@/lib/validation";

/**
 * POST: a CSV file (SW23). `what` is "journal" (a kind's month, posted or
 * not yet), "worksheet" (a kind's items by month) or "template" (the
 * headings for bringing items in). Read-only; anyone who can see the books.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const what = requireOneOf(body.what, "what", ["journal", "worksheet", "template"] as const);
  const file = await withOrganisation(request, body.organisationId, "viewer", async (tx) =>
    what === "journal" ? monthJournalFile(tx, body.kind, body.month) : what === "worksheet" ? worksheetFile(tx, body.kind) : importTemplateFile(),
  );
  return new Response(file.csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
