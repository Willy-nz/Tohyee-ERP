import { describe, expect, it } from "vitest";
import { needsFullRead, olderOrdersGap, readableFrom } from "@/lib/sales-platforms/order-history";
import { guidePayoutLine, type PayoutCandidate, type PayoutConnection } from "@/lib/sales-platforms/payout-match";
import { bankWordsList } from "@/lib/sales-platforms/setup";

/** Examples SPC47, SPC48 and SPC50 (following common practice, not yet reviewed), the pure parts. */

const ORDERS = ["read_customers", "read_products", "read_orders"];
const history = (overrides: Partial<Parameters<typeof olderOrdersGap>[0]> = {}) => ({
  platform: "shopify",
  startDate: "2026-08-01",
  grantedScopes: ORDERS,
  ordersReadFrom: null as string | null,
  ...overrides,
});
// 3 Nov 2026, 9am NZDT.
const NOW = new Date("2026-11-02T20:00:00Z");

describe("SPC47: Shopify's 60 days of orders", () => {
  it("reaches back 60 days without read_all_orders, to the start date with it", () => {
    expect(readableFrom(history(), NOW)).toBe("2026-09-04");
    expect(readableFrom(history({ startDate: "2026-10-01" }), NOW)).toBe("2026-10-01");
    expect(readableFrom(history({ grantedScopes: [...ORDERS, "read_all_orders"] }), NOW)).toBe("2026-08-01");
    expect(readableFrom(history({ platform: "woocommerce" }), NOW)).toBe("2026-08-01");
    expect(readableFrom(history({ startDate: null }), NOW)).toBeNull();
  });

  it("names the orders never read, until read_all_orders is given", () => {
    const gap = olderOrdersGap(history({ ordersReadFrom: "2026-09-04" }));
    expect(gap).toMatchObject({ from: "2026-08-01", to: "2026-09-03" });
    expect(gap!.message).toContain("Add read_all_orders");
    expect(olderOrdersGap(history({ ordersReadFrom: "2026-09-04", grantedScopes: [...ORDERS, "read_all_orders"] }))).toBeNull();
    expect(olderOrdersGap(history({ ordersReadFrom: "2026-08-01" }))).toBeNull();
    expect(olderOrdersGap(history({ ordersReadFrom: null }))).toBeNull();
    expect(olderOrdersGap(history({ platform: "woocommerce", ordersReadFrom: "2026-09-04" }))).toBeNull();
  });
});

describe("SPC48: when a sync reads every order again", () => {
  it("on the first read, and when a read now reaches further back than before", () => {
    expect(needsFullRead(history(), null, NOW)).toBe(true);
    // Nothing more to reach: an ordinary changed-since read.
    expect(needsFullRead(history({ ordersReadFrom: "2026-09-04" }), "2026-11-02T21:00:00Z", NOW)).toBe(false);
    expect(needsFullRead(history({ ordersReadFrom: "2026-09-04" }), "2026-11-02T21:00:00Z", new Date("2026-12-01T00:00:00Z"))).toBe(false);
    // read_all_orders given.
    expect(needsFullRead(history({ ordersReadFrom: "2026-09-04", grantedScopes: [...ORDERS, "read_all_orders"] }), "2026-11-02T21:00:00Z", NOW)).toBe(true);
    // The start date moved back, inside the 60 days.
    expect(needsFullRead(history({ startDate: "2026-10-01", ordersReadFrom: "2026-10-15" }), "2026-11-02T21:00:00Z", NOW)).toBe(true);
    expect(needsFullRead(history({ startDate: null }), null, NOW)).toBe(false);
  });
});

describe("SPC50: the store's own words for its payout", () => {
  const BANK = "11";
  const shop: PayoutConnection = {
    connectionId: "1",
    platformLabel: "Shopify",
    names: ["shopify"],
    bankWords: ["glenmore candles"],
    postingOn: true,
    payoutAccountId: BANK,
    payoutAccountCode: "1000",
    clearingAccountCode: "1010",
    clearingAccountName: "Money held by Shopify",
    startDate: "2026-10-01",
    missing: [],
    readsPayouts: true,
  };
  const payout: PayoutCandidate = {
    connectionId: "1",
    platformLabel: "Shopify",
    externalId: "70001",
    issuedOn: "2026-10-07",
    status: "PAID",
    direction: "DEPOSIT",
    net: "49.38",
    currency: "NZD",
    settlement: null,
    posted: { journalLineId: "jl-1", journalId: "j-1", reconciledLineId: null, reconciledLineDate: null },
    refusal: null,
    ordersNotInBooks: [],
  };
  const line = (amount: string, text: string, accountId = BANK) => ({ id: "500", accountId, date: "2026-10-08", amount, text });

  it("count like Shopify's name on the payouts account, never on amount or words alone", () => {
    expect(guidePayoutLine(line("49.38", "Glenmore Candles TRF 1Z6"), [shop], [payout])).toMatchObject({ status: "matched", evidence: "platform_amount_date" });
    expect(guidePayoutLine(line("49.38", "Glenmore Candles TRF 1Z6"), [{ ...shop, bankWords: [] }], [payout])).toMatchObject({ status: "needs_choice", evidence: "amount_date" });
    expect(guidePayoutLine(line("12.00", "Glenmore Candles TRF 1Z6"), [shop], [payout])).not.toMatchObject({ status: "matched" });
  });

  it("mean nothing on another account, where the store's name could be any transfer", () => {
    expect(guidePayoutLine(line("49.38", "Glenmore Candles TRF 1Z6", "12"), [shop], [payout])).toBeNull();
    expect(guidePayoutLine(line("49.38", "SHOPIFY PAYOUT", "12"), [shop], [payout])).toMatchObject({ status: "missing_posting_setup" });
  });

  it("are typed comma separated in the setup", () => {
    expect(bankWordsList(" Glenmore  Candles, GLENMORE ,, ")).toEqual(["Glenmore Candles", "GLENMORE"]);
    expect(bankWordsList("")).toEqual([]);
  });
});
