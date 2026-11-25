import { type NextRequest, NextResponse } from "next/server";
import { newNonce, SCRIPT_POLICY_HEADER, scriptPolicy } from "@/lib/security/script-policy";

/*
 * Adds the page script policy (src/lib/security/script-policy.ts), with a
 * fresh nonce, to page requests. It's on the request too, which is where Next
 * reads the nonce from to put on its own scripts. It's report-only: nothing
 * is blocked. The page policy that is enforced (framing, forms, images) is
 * still set in next.config.ts.
 */
export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const policy = scriptPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(SCRIPT_POLICY_HEADER, policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(SCRIPT_POLICY_HEADER, policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API, Next's static files, files with an extension, or the
      // PowerPoint add-in's pages, which Office frames and which load Office.js.
      source: "/((?!api/|_next/static|_next/image|office/|.*\\.[A-Za-z0-9]+$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
