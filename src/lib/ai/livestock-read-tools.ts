import { currentLivestockYearEnd } from "@/lib/ai/farm-tools";
import { boundedLimit, CURSOR, limitInput, pageByPosition } from "@/lib/ai/limits";
import { type AiTool, DATE, schema } from "@/lib/ai/tools";
import type { OrgTx } from "@/lib/db/org-transaction";
import { listAccountSales } from "@/lib/livestock/account-sales";
import { listHighPriced } from "@/lib/livestock/high-priced";
import { listManagementValues, managementReport } from "@/lib/livestock/management";
import { getLivestockSettings, listLocations, listOpenings, previewAgeing, requireLivestock } from "@/lib/livestock/movements";
import { listRates, previewValuation } from "@/lib/livestock/valuation";

/*
 * Reads for the Livestock year-end screens: what a
 * viewer can open under Livestock, for an AI helping with the year end.
 * Each calls the service its screen calls. The previews work the figures
 * out and change nothing: approving a valuation and running ageing stay
 * with a person.
 */

const PAGE = { limit: limitInput(100, 500), cursor: CURSOR };
const YEAR_END = { ...DATE, description: "The financial year's last day (YYYY-MM-DD). Defaults to the current year." };

function paged<T>(field: string, rows: readonly T[], args: Record<string, unknown>) {
  const page = pageByPosition(rows, args.cursor, boundedLimit(args.limit, 100, 500));
  return { [field]: page.rows, more: page.more, nextCursor: page.nextCursor };
}

const yearEndOf = async (tx: OrgTx, value: unknown) => (typeof value === "string" && value ? value : await currentLivestockYearEnd(tx));

export const LIVESTOCK_READ_TOOLS: AiTool[] = [
  {
    name: "livestock_settings",
    title: "Livestock settings",
    description: "How Livestock is set up: whether it's on, the first year, the financial year end month, where a herd scheme revaluation goes, the reporting basis, and which classes are current assets.",
    level: "read",
    inputSchema: schema({}),
    run: (tx) => getLivestockSettings(tx),
  },
  {
    name: "list_livestock_openings",
    title: "Livestock opening balances",
    description: "The opening head and value entered for each class of livestock at the start of the first year.",
    level: "read",
    inputSchema: schema(PAGE),
    run: async (tx, args) => {
      await requireLivestock(tx);
      return paged("openings", await listOpenings(tx), args);
    },
  },
  {
    name: "list_livestock_locations",
    title: "Livestock locations",
    description: "The places livestock movements can be recorded against, archived ones included.",
    level: "read",
    inputSchema: schema(PAGE),
    run: async (tx, args) => {
      await requireLivestock(tx);
      return paged("locations", await listLocations(tx), args);
    },
  },
  {
    name: "list_livestock_rates",
    title: "Livestock rates",
    description: "The national average market values (NAMV) and national standard costs (NSC) entered for each kind and category of livestock, with where each came from. incomeYear gives one year only.",
    level: "read",
    inputSchema: schema({ incomeYear: { type: "integer", description: "One income year only, e.g. 2026." }, ...PAGE }),
    run: async (tx, args) => {
      await requireLivestock(tx);
      return paged("rates", await listRates(tx, { incomeYear: args.incomeYear ?? undefined }), args);
    },
  },
  {
    name: "list_high_priced_livestock",
    title: "High-priced livestock",
    description: "Animals on the high-priced livestock register: what each is, when it was bought, its cost, its depreciation rate and where the rate came from, and when and how it left.",
    level: "read",
    inputSchema: schema(PAGE),
    run: async (tx, args) => {
      await requireLivestock(tx);
      return paged("animals", await listHighPriced(tx), args);
    },
  },
  {
    name: "list_livestock_account_sales",
    title: "Livestock account sales",
    description: "Account sales from stock agents: the agent, reference and date, gross, deductions and net, what's still due, the invoice and bill each made, and any that were voided.",
    level: "read",
    inputSchema: schema(PAGE),
    run: async (tx, args) => {
      await requireLivestock(tx);
      return paged("accountSales", await listAccountSales(tx), args);
    },
  },
  {
    name: "list_livestock_management_values",
    title: "Livestock management values",
    description: "The value per head set for each class for management reporting, and the month each applies from. These are the farm's own values, not tax values.",
    level: "read",
    inputSchema: schema(PAGE),
    run: async (tx, args) => {
      await requireLivestock(tx);
      return paged("values", await listManagementValues(tx), args);
    },
  },
  {
    name: "livestock_management_report",
    title: "Livestock management report",
    description: "A year's livestock at management values, month by month from the opening, with any classes that have stock but no value per head (those are valued at 0.00 until one is set).",
    level: "read",
    inputSchema: schema({ yearEnd: YEAR_END }),
    run: async (tx, args) => managementReport(tx, { yearEnd: await yearEndOf(tx, args.yearEnd) }),
  },
  {
    name: "livestock_ageing_preview",
    title: "Livestock ageing preview",
    description: "What ageing does at the start of a year: each class's head at the end of the year before moving to the next class, and the classes that need a split first. Worked out only; nothing is changed.",
    level: "read",
    inputSchema: schema({ yearEnd: YEAR_END }),
    run: async (tx, args) => previewAgeing(tx, { yearEnd: await yearEndOf(tx, args.yearEnd) }),
  },
  {
    name: "livestock_valuation_preview",
    title: "Livestock valuation preview",
    description: "A year end's livestock valuation as Livestock › Valuation works it out before approval: the workings, the journal it would post, notices, what stops approval, the asset account's balance against the opening value, and the approved valuation if there is one. Worked out only; approving is for a person.",
    level: "read",
    inputSchema: schema({ yearEnd: YEAR_END }),
    run: async (tx, args) => previewValuation(tx, { yearEnd: await yearEndOf(tx, args.yearEnd) }),
  },
];
