import { inRoundedUnits, type ReportRounding } from "@/lib/reports/rounding";

/** How statement amounts print (FS3): pure, so the screen and the PDF share it. */

/** Shows an amount as in printed statements: 1,234.56, negatives in brackets, "-" for nothing. */
export function statementAmount(value: string | null): string {
  if (value === null) return "";
  const negative = value.startsWith("-");
  const [whole, cents = "00"] = (negative ? value.slice(1) : value).split(".");
  if (/^0+$/.test(whole) && /^0*$/.test(cents)) return "-";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `(${grouped}.${cents})` : `${grouped}.${cents}`;
}

/** A rounded amount in its units, as statements print amounts (RND7): 12,000.00 in thousands is 12, a minus in brackets, "-" for nothing. */
export function statementAmountIn(value: string | null, rounding: ReportRounding): string {
  if (value === null) return "";
  const units = inRoundedUnits(value, rounding);
  if (units === "0") return "-";
  const grouped = units.replace(/^-/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return units.startsWith("-") ? `(${grouped})` : grouped;
}

/** A line's amount as printed: money as in statements (FS3), in the statement's rounded units when it has them, a % or plain number from a layout. */
export function statementValue(line: { format?: "money" | "percent" | "number" }, value: string | null, rounding?: ReportRounding): string {
  if (line.format === "percent") return value === null ? "" : `${value}%`;
  if (line.format === "number") return value ?? "";
  return rounding ? statementAmountIn(value ?? "0", rounding) : statementAmount(value ?? "0");
}
