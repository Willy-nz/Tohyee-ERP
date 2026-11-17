import { describe, expect, it } from "vitest";
import { gbpDailyQuery, gbpDayRows, gbpMonths, gbpReviewRows, gbpSearchTermRows, gbpSpans } from "@/lib/analytics/business-profile-reports";
import { amount, customerId, GADS_TABLES, gadsQuery, gadsRows, micros } from "@/lib/analytics/google-ads-reports";

/** Examples GBP3-GBP5 and GADS3-GADS5 in docs/ACCOUNTING-EXAMPLES.md (following common practice, not yet reviewed). Made-up figures. */
describe("Business Profile rows", () => {
  it("GBP3 asks for about 18 months to yesterday in parts, and the last 12 whole months of search terms", () => {
    const spans = gbpSpans("2026-11-16");
    expect(spans[0]).toEqual({ from: "2025-05-25", to: "2025-11-20" });
    expect(spans.at(-1)!.to).toBe("2026-11-15");
    expect(spans).toHaveLength(3);
    expect(gbpMonths("2026-11-16")).toEqual(["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"]);
    expect(gbpDailyQuery({ from: "2026-11-01", to: "2026-11-15" })).toContain("dailyRange.startDate.year=2026&dailyRange.startDate.month=11&dailyRange.startDate.day=1");
  });

  it("GBP4 one row a day, views added up from Search and Maps on phones and computers", () => {
    const day = { year: 2026, month: 11, day: 14 };
    const series = (metric: string, value: string) => ({ dailyMetric: metric, timeSeries: { datedValues: [{ date: day, value }, { date: { year: 2026, month: 11, day: 15 } }] } });
    const rows = gbpDayRows([
      {
        multiDailyMetricTimeSeries: [
          { dailyMetricTimeSeries: [series("BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "40"), series("BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "12"), series("BUSINESS_IMPRESSIONS_MOBILE_MAPS", "30")] },
          { dailyMetricTimeSeries: [series("BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "3"), series("CALL_CLICKS", "2"), series("WEBSITE_CLICKS", "7"), series("BUSINESS_DIRECTION_REQUESTS", "4")] },
        ],
      },
    ]);
    expect(rows).toEqual([
      ["2026-11-14", "85", "40", "12", "30", "3", "2", "4", "7", "0", "0"],
      ["2026-11-15", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0"],
    ]);
  });

  it("GBP5 reviews with stars as numbers and NZ dates; search terms below Google's privacy threshold", () => {
    expect(
      gbpReviewRows(
        [
          { reviewId: "r1", reviewer: { displayName: "Aroha N." }, starRating: "FIVE", comment: "Beautiful pendant necklace", createTime: "2026-11-13T22:30:00Z", reviewReply: { comment: "Thank you!", updateTime: "2026-11-14T01:00:00Z" } },
          { reviewId: "r2", reviewer: { isAnonymous: true }, starRating: "THREE", createTime: "2026-11-10T03:00:00Z" },
        ],
        "Pacific/Auckland",
      ),
    ).toEqual([
      ["r1", "2026-11-14", "5", "Aroha N.", "Beautiful pendant necklace", "true", "Thank you!", "2026-11-14"],
      ["r2", "2026-11-10", "3", "A Google user", null, "false", null, null],
    ]);
    expect(gbpSearchTermRows("2026-10-01", [{ searchKeywordsCounts: [{ searchKeyword: "pet keepsake jewellery", insightsValue: { value: "120" } }, { searchKeyword: "fern print ring", insightsValue: { threshold: "15" } }] }])).toEqual([
      ["2026-10-01", "pet keepsake jewellery", "120", null],
      ["2026-10-01", "fern print ring", null, "15"],
    ]);
  });
});

describe("Google Ads rows", () => {
  it("GADS3 exact money from millionths, and conversions read as written", () => {
    expect(micros("12345678")).toBe("12.35");
    expect(micros("bad")).toBe("0.00");
    expect(amount(1.5)).toBe("1.50");
    expect(amount(89.999)).toBe("90.00");
    expect(amount("1e30")).toBe("0.00");
    expect(customerId("customers/1234567890")).toBe("1234567890");
    expect(customerId("123-456-7890")).toBe("1234567890");
    expect(customerId("12345")).toBeNull();
  });

  it("GADS4 asks each table for days with impressions, and turns rows into columns", () => {
    const campaign = GADS_TABLES[0];
    expect(gadsQuery(campaign, "2025-10-12", "2026-11-16")).toBe(
      "SELECT segments.date, campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '2025-10-12' AND '2026-11-16' AND metrics.impressions > 0",
    );
    expect(() => gadsQuery(campaign, "2025-10-12' OR 1=1 --", "2026-11-16")).toThrow();
    expect(gadsRows(campaign, [{ segments: { date: "2026-11-14" }, campaign: { id: "111", name: "Pendants NZ", status: "ENABLED" }, metrics: { costMicros: "4560000", clicks: "9", impressions: "300", conversions: 1, conversionsValue: 89 } }], "NZD")).toEqual([
      ["2026-11-14", "111", "Pendants NZ", "Enabled", "4.56", "9", "300", "1.00", "89.00", "NZD"],
    ]);
    expect(gadsRows(GADS_TABLES[2], [{ segments: { date: "2026-11-14" }, campaign: { name: "Pendants NZ" }, adGroup: { name: "Necklaces" }, adGroupCriterion: { keyword: { text: "pendant necklace", matchType: "PHRASE" } }, metrics: { clicks: "3" } }], "NZD")).toEqual([
      ["2026-11-14", "Pendants NZ", "Necklaces", "pendant necklace", "Phrase", "0.00", "3", "0", "0.00", "0.00", "NZD"],
    ]);
  });
});
