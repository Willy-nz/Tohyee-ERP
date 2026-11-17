import { protectedResourceMetadataRoute } from "@/lib/ai/oauth/http";

/** RFC 9728 protected resource metadata for /api/mcp (the well-known part goes before the path). */
export const dynamic = "force-dynamic";
export const GET = protectedResourceMetadataRoute;
