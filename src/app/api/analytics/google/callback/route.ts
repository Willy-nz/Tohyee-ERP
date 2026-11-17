import { withOrganisation } from "@/lib/api/http";
import { claimGoogleState, fetchGaSignIn, googleStateProduct, saveGaSignIn } from "@/lib/analytics/google-analytics";
import { fetchGmcSignIn, saveGmcSignIn } from "@/lib/analytics/merchant-center";
import { businessProfile } from "@/lib/analytics/business-profile";
import { googleAds } from "@/lib/analytics/google-ads";
import { fetchGscSignIn, saveGscSignIn } from "@/lib/analytics/search-console";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { organisationFromState } from "@/lib/crm/mail/service";

/**
 * Where Google sends the browser back after signing in, for Google
 * Analytics (GA1), Google Search Console (GSC1) and Google
 * Merchant Center (GMC1): checks
 * the one-time state against the signed-in admin, exchanges the code
 * outside any database transaction, stores the sign-in on the connection
 * the state was for, and goes back to Data sources to choose what to load.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = await requestOrigin(request);
  let key = "googleAnalytics";
  const back = (query: Record<string, string>) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/analytics/sources?${new URLSearchParams({ [key]: query.status, ...(query.message ? { message: query.message } : {}) })}` } });
  try {
    const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const state = url.searchParams.get("state");
    const organisationId = organisationFromState(state);
    // Which connection it's for first, so even an expired link goes back to the right screen.
    const started = await withOrganisation(request, organisationId, "admin", (tx) => googleStateProduct(tx, state!));
    if (started === "search_console") key = "googleSearchConsole";
    if (started === "merchant_center") key = "googleMerchantCenter";
    if (started === "business_profile") key = "googleBusinessProfile";
    if (started === "google_ads") key = "googleAds";
    const { app, product } = await withOrganisation(request, organisationId, "admin", (tx) => claimGoogleState(tx, state!));
    if (providerError) return back({ status: "error", message: `Signing in didn't finish: ${providerError}` });
    const code = url.searchParams.get("code");
    if (!code) return back({ status: "error", message: "Signing in didn't return a code. Try connecting again." });
    if (product === "business_profile" || product === "google_ads") {
      const source = product === "business_profile" ? businessProfile : googleAds;
      const signIn = await source.fetchSignIn(app, code, origin);
      await withOrganisation(request, organisationId, "admin", async (tx) => {
        await source.saveSignIn(tx, signIn);
      });
    } else if (product === "merchant_center") {
      const signIn = await fetchGmcSignIn(app, code, origin);
      await withOrganisation(request, organisationId, "admin", (tx) => saveGmcSignIn(tx, signIn));
    } else if (product === "search_console") {
      const signIn = await fetchGscSignIn(app, code, origin);
      await withOrganisation(request, organisationId, "admin", (tx) => saveGscSignIn(tx, signIn));
    } else {
      const signIn = await fetchGaSignIn(app, code, origin);
      await withOrganisation(request, organisationId, "admin", (tx) => saveGaSignIn(tx, signIn));
    }
    return back({ status: "connected" });
  } catch (error) {
    return back({ status: "error", message: error instanceof Error ? error.message : "Connecting didn't work. Try again." });
  }
}
