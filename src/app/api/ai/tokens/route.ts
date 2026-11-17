import { roleMayUseAi } from "@/lib/ai/farm-staff";
import type { AuthContext } from "@/lib/auth/guard";
import { ForbiddenError } from "@/lib/errors";
import { json, readJson, requireAuth, route, searchParams } from "@/lib/api/http";
import { oauthAddressesFor } from "@/lib/ai/oauth/config";
import { MAX_ACTIVE_CONNECTIONS } from "@/lib/ai/oauth/format";
import { createAiToken, listAiTokens, MAX_ACTIVE_AI_TOKENS, remoteAccessAddress } from "@/lib/ai/tokens";
import { requireOrganisationRole } from "@/lib/auth/guard";
import { parseOrganisationId } from "@/lib/organisations/registry";

/**
 * GET: the signed-in person's own AI keys and connected AI apps for the
 * organisation (never a key, token or hash; `kind` tells them apart), the
 * most they can have, the remote access address when remote access is on,
 * and the MCP address AI apps can sign in at (null unless it's https). Any member (viewer and up), and farm staff.
 */
/** Anyone who can read the books, and farm staff for field work on their farms. Not the CRM-only or report-only roles. */
async function requireAiMember(auth: AuthContext, organisationId: string) {
  const membership = await requireOrganisationRole(auth, organisationId, "farm_worker");
  if (!roleMayUseAi(membership.role)) throw new ForbiddenError("AI keys need the farm staff or viewer role or higher in this organisation.");
  return membership;
}

export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  const organisationId = parseOrganisationId(searchParams(request).get("organisationId"));
  await requireAiMember(auth, organisationId);
  const remoteAddress = await remoteAccessAddress();
  return json({
    keys: await listAiTokens(auth, organisationId),
    maxActiveKeys: MAX_ACTIVE_AI_TOKENS,
    maxActiveConnections: MAX_ACTIVE_CONNECTIONS,
    remoteAddress,
    signInAddress: oauthAddressesFor(remoteAddress)?.resource ?? null,
  });
});

/**
 * POST { organisationId, name, accessLevel?, confirmFullAccess?, endsInDays? }: makes a
 * key (accessLevel read, draft, post or full; read when left out). The key is
 * in this answer only. read, draft and post can be chosen by anyone and are
 * capped by the person's role whenever it's used; full needs the Owner role
 * and confirmFullAccess true. endsInDays is 30, 90, 365 or
 * null for no end date; left out, 90 for a key that can post.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const organisationId = parseOrganisationId(body.organisationId);
  const membership = await requireAiMember(auth, organisationId);
  const result = await createAiToken(auth, organisationId, {
    name: body.name,
    accessLevel: body.accessLevel,
    role: membership.role,
    confirmFullAccess: body.confirmFullAccess,
    endsInDays: body.endsInDays,
    toolScope: body.toolScope,
  });
  return json(result, { status: 201 });
});
