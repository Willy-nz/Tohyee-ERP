import { describe, expect, it } from "vitest";
import { periodFromText, usualAmount } from "@/lib/spreading/suggest-rules";

const period = (text: string, date = "2026-11-10") => {
  const found = periodFromText(text, date);
  return found ? [found.startDate, found.endDate, found.because] : null;
};

describe("Spreading suggestions", () => {
  it("SW26 reads a written date range off a line", () => {
    expect(period("Farm insurance 1 Jan 2027 to 31 Dec 2027")).toEqual(["2027-01-01", "2027-12-31", "1 Jan 2027 to 31 Dec 2027"]);
    expect(period("Cover 01/07/2026 - 30/06/2027")).toEqual(["2026-07-01", "2027-06-30", "01/07/2026 - 30/06/2027"]);
    // Day first, as New Zealand writes dates: 3/4 is 3 April.
    expect(period("Lease 3/4/26 to 2/10/26")).toEqual(["2026-04-03", "2026-10-02", "3/4/26 to 2/10/26"]);
    expect(period("Software Jul 2026 to Jun 2027")).toEqual(["2026-07-01", "2027-06-30", "Jul 2026 to Jun 2027"]);
    // A start with no year takes the end's, or the year before when its month comes later.
    expect(period("Rates 1 July to 30 June 2027")).toEqual(["2026-07-01", "2027-06-30", "1 July to 30 June 2027"]);
    expect(period("Rent January – March 2027")).toEqual(["2027-01-01", "2027-03-31", "January – March 2027"]);
    expect(period("Support 2026-12-01 until 2027-11-30")).toEqual(["2026-12-01", "2027-11-30", "2026-12-01 until 2027-11-30"]);
    expect(period("Subscription 1st December 2026 through 28th February 2027")).toEqual(["2026-12-01", "2027-02-28", "1st December 2026 through 28th February 2027"]);
  });

  it("SW26 reads a length, counted from the document's date", () => {
    expect(period("Annual software licence", "2026-11-10")).toEqual(["2026-11-10", "2027-11-09", "Annual"]);
    expect(period("12 months hosting", "2026-03-15")).toEqual(["2026-03-15", "2027-03-14", "12 months"]);
    expect(period("Quarterly rent", "2026-10-01")).toEqual(["2026-10-01", "2026-12-31", "Quarterly"]);
    expect(period("Six month membership", "2026-08-31")).toEqual(["2026-08-31", "2027-02-27", "Six month"]);
    expect(period("2 year warranty", "2026-11-10")).toEqual(["2026-11-10", "2028-11-09", "2 year"]);
    // A written range wins over a length.
    expect(period("Annual cover 1 Dec 2026 to 31 May 2027")).toEqual(["2026-12-01", "2027-05-31", "1 Dec 2026 to 31 May 2027"]);
  });

  it("SW26 says nothing when the words don't, or when there'd be nothing to spread", () => {
    expect(period("Diesel")).toBeNull();
    expect(period("Monthly retainer")).toBeNull();
    expect(period("1 month hire")).toBeNull();
    // Inside one month.
    expect(period("Hire 3 Nov 2026 to 20 Nov 2026")).toBeNull();
    // Not dates.
    expect(period("Part 10-20 widget")).toBeNull();
    expect(period("Invoice 2026-11")).toBeNull();
    expect(period("31/02/2027 to 31/12/2027")).toBeNull();
    // Backwards.
    expect(period("31 Dec 2027 to 1 Jan 2027")).toBeNull();
    // Too long to be a mistake worth suggesting.
    expect(period("99 year lease")).toBeNull();
    expect(period("Annual leave payout")).toEqual(["2026-11-10", "2027-11-09", "Annual"]);
  });

  it("SW27 the usual amount is the average of the last three months, only when each had a bill and this one hasn't", () => {
    const cents = (entries: Array<[string, number]>) => new Map(entries);
    expect(usualAmount(cents([["2026-08", 41000], ["2026-09", 39500], ["2026-10", 42750]]), "2026-11")).toBe(41083);
    // One of the three is missing.
    expect(usualAmount(cents([["2026-08", 41000], ["2026-10", 42750]]), "2026-11")).toBeNull();
    // The bill's already here.
    expect(usualAmount(cents([["2026-08", 41000], ["2026-09", 39500], ["2026-10", 42750], ["2026-11", 40000]]), "2026-11")).toBeNull();
    // Across a year end.
    expect(usualAmount(cents([["2026-10", 100], ["2026-11", 200], ["2026-12", 300]]), "2027-01")).toBe(200);
  });
});
