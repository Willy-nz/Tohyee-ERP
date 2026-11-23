import { readJson, route, withOrganisation } from "@/lib/api/http";
import { searchFile } from "@/lib/saved-searches/service";

/** POST: a search's rows as a CSV file, up to 5,000. Read-only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const file = await withOrganisation(request, body.organisationId, "viewer", (tx) => searchFile(tx, { recordType: body.recordType, definition: body.definition, name: body.name }));
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
