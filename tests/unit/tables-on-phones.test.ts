import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * On a phone a table cell doesn't wrap, so a table outside a scrolling box
 * pushes the whole page sideways. Every <table> sits in ui.tableWrap (or
 * another box that scrolls or hides it), or stacks on a phone (stackOnPhone).
 */

const ROOT = path.resolve(__dirname, "../../src");
// Not lists: a month grid, a chart's hidden data table, and tables inside their own scrolling or narrow boxes.
const ALLOWED = new Set([
  "components/farm-calendar.tsx",
  "components/analytics/chart.tsx",
  "components/analytics-shaping.tsx",
  "components/analytics/items.tsx",
  "components/bank/gateway-settlement-guide.tsx",
  "components/bank/recode-in-place.tsx",
  "components/bank/payout-guide.tsx",
]);

function files(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const full = path.join(folder, name);
    return statSync(full).isDirectory() ? files(full) : name.endsWith(".tsx") ? [full] : [];
  });
}

describe("tables on phones", () => {
  it("every table scrolls inside its box or stacks", () => {
    const bare: string[] = [];
    for (const file of files(ROOT)) {
      const relative = path.relative(ROOT, file).split(path.sep).join("/");
      if (ALLOWED.has(relative)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/<table\b/.test(line)) return;
        const before = lines.slice(Math.max(0, index - 3), index + 1).join("\n");
        if (/tableWrap|stackOnPhone|overflow|Wrap|scroll/i.test(before)) return;
        bare.push(`${relative}:${index + 1}`);
      });
    }
    expect(bare, "wrap these in <div className={ui.tableWrap}>").toEqual([]);
  });
});
