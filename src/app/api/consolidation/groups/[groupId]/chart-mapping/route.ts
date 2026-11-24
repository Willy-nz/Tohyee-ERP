import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { getChartMapping, setChartMapping } from "@/lib/consolidation/mapping";

type Context = { params: Promise<{ groupId: string }> };

/** GET `?member=<organisation>`: a member's accounts and which of the parent's accounts each goes to on the group's reports (CO16). */
export const GET = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json({ mapping: await getChartMapping({ id: auth.user.id, email: auth.user.email }, groupId, new URL(request.url).searchParams.get("member")) });
});

/** PUT `{ organisationId, maps: [{ accountId, parentAccountId | null }] }`: saves where those accounts go. Admins of every organisation. */
export const PUT = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  return json({ mapping: await setChartMapping({ id: auth.user.id, email: auth.user.email }, groupId, await readJson(request)) });
});
