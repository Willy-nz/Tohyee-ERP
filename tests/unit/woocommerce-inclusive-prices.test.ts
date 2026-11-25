import { expect, it } from "vitest";
import { dec, divide, sub, toFixedString } from "@/lib/money/decimal";
import { planOrder, type PostingRules } from "@/lib/sales-platforms/orders";
import { wooOrderFrom } from "@/lib/sales-platforms/woocommerce";
import { order2002, wooOrderNode } from "../helpers/fake-woocommerce";

const RULES: PostingRules = {
  baseCurrency: "NZD",
  gstRegistered: true,
  foreignTrade: false,
  exportTaxCode: "EXPORT",
  untaxedTaxCode: "ZERO",
  taxCodes: [{ rate: "0.15", code: "GST", codeRate: "0.15" }],
  salesAccountCode: "4000",
  shippingAccountCode: "4000",
  platformName: "WooCommerce",
};

/**
 * SPF9 (review H5): a WooCommerce store with prices entered including GST. A $10.00 (incl.) product is
 * sent as total 8.70 + tax 1.30; it comes in as 10.00 including GST, so the invoice comes to 10.00.
 */
it("SPF9: a $10.00 GST-inclusive WooCommerce line", () => {
  const order = wooOrderFrom(
    wooOrderNode(order2002({ lines: [{ id: 2, productId: 302, sku: "MELT-VAN", name: "Wax melts", quantity: 1, subtotal: "8.70", total: "8.70", tax: "1.30" }], shipping: undefined, total: "10.00" })),
  );
  const plan = planOrder(order, RULES, new Map(), false);
  // SPF9: brought in including GST, the invoice comes to 10.00 with GST 1.30, WooCommerce's own tax.
  expect(plan.ok).toBe(true);
  expect(plan.ok && plan.total).toBe("10.00");
  expect(plan.ok && plan.amountsMode).toBe("inclusive");
  expect(plan.ok && plan.notes).toEqual([]);
});

it("SPF9: no whole-dollar GST-inclusive price from $1 to $200 is refused", () => {
  const refused: string[] = [];
  for (let cents = 100; cents <= 20000; cents += 100) {
    const gross = toFixedString(dec(String(cents / 100)), 2);
    // WooCommerce works out the price before tax and its tax, each to 2 places (tax rounded at line level).
    const net = divide(dec(gross), dec("1.15"), 2);
    const tax = sub(dec(gross), net);
    const order = wooOrderFrom(
      wooOrderNode(order2002({ lines: [{ id: 2, productId: 302, sku: "MELT-VAN", name: "X", quantity: 1, subtotal: toFixedString(net, 2), total: toFixedString(net, 2), tax: toFixedString(tax, 2) }], shipping: undefined, total: gross })),
    );
    if (!planOrder(order, RULES, new Map(), false).ok) refused.push(gross);
  }
  expect(refused).toEqual([]);
});
