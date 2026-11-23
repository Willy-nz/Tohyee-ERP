import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { runSearch } from "@/lib/saved-searches/service";

/** POST, because the search is sent in the body: runs it against the live books and returns a page of rows. Read-only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", (tx) =>
    runSearch(tx, { recordType: body.recordType, definition: body.definition, offset: body.offset }),
  );
  return json({ result });
});
