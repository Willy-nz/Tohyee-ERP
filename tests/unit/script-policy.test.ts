import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { THEME_SCRIPT } from "@/components/theme-script";
import { newNonce, SCRIPT_POLICY_HEADER, scriptPolicy, THEME_SCRIPT_HASH } from "@/lib/security/script-policy";
import { config, proxy } from "@/proxy";

/** The page script policy (report-only for now). */
describe("page script policy", () => {
  it("allows only Tohyee's own scripts, with this response's nonce, and the theme script by its hash", () => {
    const policy = scriptPolicy("bm9uY2U=", false);
    expect(policy).toBe(`script-src 'self' 'nonce-bm9uY2U=' 'strict-dynamic' ${THEME_SCRIPT_HASH}; object-src 'none'; base-uri 'self'`);
    expect(THEME_SCRIPT_HASH).toBe(`'sha256-${createHash("sha256").update(THEME_SCRIPT).digest("base64")}'`);
    expect(scriptPolicy("x", true)).toContain("'unsafe-eval'");
    expect(policy).not.toContain("unsafe-inline");
  });

  it("uses a new nonce for every response, on the request (for Next) and the response", () => {
    expect(newNonce()).not.toBe(newNonce());
    const first = proxy(new NextRequest("http://tohyee.test/operations"));
    const second = proxy(new NextRequest("http://tohyee.test/operations"));
    const policy = first.headers.get(SCRIPT_POLICY_HEADER)!;
    expect(policy).toMatch(/'nonce-[A-Za-z0-9+/=]{24}'/);
    expect(second.headers.get(SCRIPT_POLICY_HEADER)).not.toBe(policy);
    expect(first.headers.get("x-middleware-request-content-security-policy-report-only")).toBe(policy);
    // Report-only: the enforced policy stays as next.config.ts sets it.
    expect(first.headers.get("content-security-policy")).toBeNull();
  });

  it("runs on pages only", () => {
    const pattern = new RegExp(`^${config.matcher[0].source}$`);
    for (const page of ["/", "/operations", "/operations/invoices/12", "/login"]) expect(pattern.test(page), page).toBe(true);
    for (const other of ["/api/auth/session", "/_next/static/chunks/a.js", "/favicon.ico", "/office/powerpoint", "/logo.png"]) expect(pattern.test(other), other).toBe(false);
  });
});
