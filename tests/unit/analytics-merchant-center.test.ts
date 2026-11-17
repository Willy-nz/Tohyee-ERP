import { describe, expect, it } from "vitest";
import { gmcDayRows, gmcIssueRows, gmcMoney, gmcPerformanceQuery, gmcProductRows, gmcStatus, gmcWindow, shopifyIds } from "@/lib/analytics/merchant-center-reports";

/** Examples GMC3-GMC5 in docs/ACCOUNTING-EXAMPLES.md (Merchant Center, following common practice, not yet reviewed). Made-up products. */
describe("Merchant Center rows", () => {
  it("GMC4 turns Google's millionths into exact money", () => {
    expect(gmcMoney({ amountMicros: "89000000", currencyCode: "NZD" })).toBe("89.00");
    expect(gmcMoney({ amountMicros: "15990000", currencyCode: "NZD" })).toBe("15.99");
    expect(gmcMoney({ amountMicros: "1005000", currencyCode: "NZD" })).toBe("1.01");
    expect(gmcMoney({ amountMicros: "12.5" })).toBeNull();
    expect(gmcMoney(undefined)).toBeNull();
  });

  it("GMC4 says where a product is shown in plain words", () => {
    const statuses = [
      { reportingContext: "SHOPPING_ADS", approvedCountries: ["NZ"], disapprovedCountries: ["AU"] },
      { reportingContext: "FREE_LISTINGS", approvedCountries: ["NZ", "AU"] },
    ];
    expect(gmcStatus(statuses, "SHOPPING_ADS")).toBe("Partly approved");
    expect(gmcStatus(statuses, "FREE_LISTINGS")).toBe("Approved");
    expect(gmcStatus([{ reportingContext: "SHOPPING_ADS", pendingCountries: ["NZ"] }], "SHOPPING_ADS")).toBe("Pending");
    expect(gmcStatus([{ reportingContext: "SHOPPING_ADS", disapprovedCountries: ["NZ"] }], "SHOPPING_ADS")).toBe("Disapproved");
    expect(gmcStatus(statuses, "DISPLAY_ADS")).toBeNull();
  });

  it("GMC5 finds Shopify's product and variant in its offer ids", () => {
    expect(shopifyIds("shopify_NZ_7712345678_43211234")).toEqual({ product: "7712345678", variant: "43211234" });
    expect(shopifyIds("PAW-SILVER")).toEqual({ product: null, variant: null });
  });

  it("GMC3 a product row, its issues, and clicks by day", () => {
    const products = [
      {
        offerId: "shopify_NZ_77_43",
        contentLanguage: "en",
        feedLabel: "NZ",
        productAttributes: { title: "Pendant pendant", brand: "Glenmore", link: "https://shop.example/paw", gtins: ["9421234567890"], price: { amountMicros: "89000000", currencyCode: "NZD" }, availability: "IN_STOCK" },
        productStatus: {
          destinationStatuses: [{ reportingContext: "SHOPPING_ADS", disapprovedCountries: ["NZ"] }, { reportingContext: "FREE_LISTINGS", approvedCountries: ["NZ"] }],
          itemLevelIssues: [
            { code: "image_too_small", severity: "DEMOTED", reportingContext: "FREE_LISTINGS", description: "Image too small", attribute: "image link", applicableCountries: ["NZ"] },
            { code: "missing_shipping", severity: "DISAPPROVED", reportingContext: "SHOPPING_ADS", description: "Missing shipping", detail: "Add shipping costs", applicableCountries: ["NZ"] },
          ],
        },
      },
      { productAttributes: { title: "No offer id, left out" } },
    ];
    expect(gmcProductRows(products)).toEqual([
      ["shopify_NZ_77_43", "Pendant pendant", "Glenmore", "https://shop.example/paw", "9421234567890", "89.00", null, "NZD", "In stock", "Disapproved", "Approved", "NZ", "NZ", "2", "Missing shipping", "NZ", "en", "77", "43"],
    ]);
    expect(gmcIssueRows(products)).toEqual([
      ["shopify_NZ_77_43", "Pendant pendant", "Demoted", "Free listings", "Image too small", null, "image link", "NZ", "image_too_small"],
      ["shopify_NZ_77_43", "Pendant pendant", "Disapproved", "Shopping ads", "Missing shipping", "Add shipping costs", null, "NZ", "missing_shipping"],
    ]);
    expect(
      gmcDayRows([
        { productPerformanceView: { date: { year: 2026, month: 11, day: 3 }, offerId: "shopify_NZ_77_43", title: "Pendant pendant", clicks: "4", impressions: "180" } },
        { productPerformanceView: { date: { year: 2026, month: 13, day: 1 }, offerId: "x", clicks: "1" } },
        { productPerformanceView: { date: { year: 2026, month: 11, day: 4 }, offerId: "PAW", impressions: "12" } },
      ]),
    ).toEqual([
      ["2026-11-03", "shopify_NZ_77_43", "Pendant pendant", "4", "180"],
      ["2026-11-04", "PAW", null, "0", "12"],
    ]);
  });

  it("asks for about 13 months of clicks and impressions", () => {
    expect(gmcWindow("2026-11-16")).toEqual({ from: "2025-10-12", to: "2026-11-16" });
    expect(gmcPerformanceQuery("2025-10-12", "2026-11-16")).toBe("SELECT date, offer_id, title, clicks, impressions FROM product_performance_view WHERE date BETWEEN '2025-10-12' AND '2026-11-16'");
    expect(() => gmcPerformanceQuery("2025-10-12' OR '1'='1", "2026-11-16")).toThrow();
  });
});
