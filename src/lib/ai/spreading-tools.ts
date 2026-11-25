import { tool } from "@/lib/ai/document-action-tools";
import { type AiTool, DATE, schema } from "@/lib/ai/tools";
import { ID } from "@/lib/ai/write-tools";
import { explainSpreadDifference } from "@/lib/spreading/explain";
import { SPREAD_KINDS, SPREAD_METHODS } from "@/lib/spreading/rules";
import { getSpreadRun, postSpreadMonth, previewSpreadMonth, undoSpreadRun } from "@/lib/spreading/runs";
import {
  createSpreadItem,
  endSpreadItemEarly,
  getSpreadItem,
  getSpreadingSettings,
  getSpreadWorksheet,
  listOpenAccruals,
  markSpreadItemDone,
  removeSpreadItem,
  settleSpreadItem,
  unsettleSpreadItem,
  updateSpreadItemTags,
} from "@/lib/spreading/service";
import { listSourceLines } from "@/lib/spreading/sources";
import { dismissSpreadSuggestion, listSpreadSuggestions } from "@/lib/spreading/suggestions";
import { ValidationError } from "@/lib/errors";

/**
 * AI tools for Accounting › Spreading (examples SW1-SW24): the worksheet
 * for prepayments, income in advance and accruals. Each calls the screen's
 * own service at the screen's role; undoing a month, undoing "bill arrived"
 * and removing an item confirm first.
 */

const KIND = {
  type: "string",
  enum: [...SPREAD_KINDS],
  description: "prepayment (paid in advance), income_in_advance, accrued_expense (not billed yet) or accrued_income (not invoiced yet).",
} as const;
const MONTH = { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "A month as YYYY-MM." } as const;
const MONEY = { type: "string", description: "A decimal without GST, e.g. \"1200.00\"." } as const;
const TAGS = {
  tracking: { type: "object", additionalProperties: { type: "string" }, description: "Tracking for each month's income or expense line: category id to value id, from list_tracking." },
  customFields: { type: "object", additionalProperties: true, description: "Custom fields used on journal lines, field id to value, from get_custom_fields." },
} as const;
const LINE_IDS = {
  billLineId: { type: "string", description: "A bill line's id from get_spreadable_lines, instead of typing the amount and account." },
  invoiceLineId: { type: "string", description: "An invoice line's id from get_spreadable_lines." },
  bankLineId: { type: "string", description: "A spend or receive money line's id from get_spreadable_lines." },
} as const;

export const SPREADING_READ_TOOLS: readonly AiTool[] = [
  {
    name: "get_spreading_worksheet",
    title: "The Spreading worksheet",
    level: "read",
    description:
      "Accounting › Spreading: everything paid or invoiced ahead and everything accrued, with each item's months (posted or not), what's left, the latest month posted for each kind, and whether each kind matches its balance sheet account (tieOut.difference is 0.00 when it does). ready is false until an admin turns Spreading on.",
    inputSchema: schema(),
    run: (tx) => getSpreadWorksheet(tx),
  },
  {
    name: "preview_spreading_month",
    title: "Preview a Spreading month",
    level: "read",
    description: "What posting one kind's month would do, without posting it: each item's amount, the journal's lines, and blocked (why it can't post yet) or runId (it already has).",
    inputSchema: schema({ kind: KIND, month: MONTH }, ["kind", "month"]),
    run: (tx, args) => previewSpreadMonth(tx, args.kind, args.month),
  },
  {
    name: "explain_spreading_difference",
    title: "What's behind a Spreading difference",
    level: "read",
    description:
      "For a kind that doesn't match its account: the entries coded to the account from outside the worksheet, and the items the worksheet expects to find there. The ones with no partner are the difference.",
    inputSchema: schema({ kind: KIND }, ["kind"]),
    run: (tx, args) => explainSpreadDifference(tx, args.kind),
  },
  {
    name: "get_spreading_suggestions",
    title: "Spreading suggestions",
    level: "read",
    description:
      "What Tohyee has noticed that could go on the Spreading worksheet; nothing is added until one is accepted. lines: recent bill, invoice and bank lines whose own words say they cover more than a month (because holds the words; startDate, endDate and months are what it read from them). Accept one with add_spreading_item, giving its billLineId, invoiceLineId or bankLineId with startDate and endDate, after checking the dates make sense against the description. accruals: suppliers who billed an expense account in each of the three months before month and haven't in month, with the average of those months as amount. Accept one with add_spreading_item (kind accrued_expense, description, amount, targetAccountCode, method one_month, month, contactId). They're guesses from patterns: check each one, say which you weren't sure of, and use dismiss_spreading_suggestion for one that's wrong so it doesn't come back.",
    inputSchema: schema(),
    run: (tx) => listSpreadSuggestions(tx),
  },
  {
    name: "get_spreadable_lines",
    title: "Lines that can be spread",
    level: "read",
    description:
      "An approved bill's, approved invoice's or posted bank transaction's lines, each with its lineId, its amount without GST, why it can't be spread (reason) or the item already spreading it (itemId), and the accruals it could be the bill or invoice for. Give exactly one of the three ids.",
    inputSchema: schema({ billId: ID("bill"), invoiceId: ID("invoice"), bankTransactionId: ID("bank transaction") }),
    async run(tx, args) {
      const given = (["billId", "invoiceId", "bankTransactionId"] as const).filter((name) => args[name] != null && args[name] !== "");
      if (given.length !== 1) throw new ValidationError("Give exactly one of billId, invoiceId or bankTransactionId.");
      const sourceKind = given[0] === "billId" ? "bill" : given[0] === "invoiceId" ? "invoice" : "bank";
      const lines = await listSourceLines(tx, sourceKind, String(args[given[0]]));
      const settings = await getSpreadingSettings(tx);
      const first = lines[0];
      return { holding: first ? settings[first.kind] : null, lines, accruals: first && settings[first.kind] ? await listOpenAccruals(tx, first.accrualKind) : [] };
    },
  },
];

export const SPREADING_ACTION_TOOLS: AiTool[] = [
  tool({
    name: "add_spreading_item",
    title: "Add something to spread",
    description:
      "Adds an item to the Spreading worksheet; nothing posts until its months are posted. Either type it (kind, description, amount without GST, targetAccountCode: the expense or income account) when the bill or invoice was coded to the kind's balance sheet account, or give one line id to do \"Spread this\" on an approved bill, invoice or bank line, which moves the line's amount there with one journal on its date. method: by_month (default) and by_days need startDate and endDate; one_month needs month; own_amounts needs ownAmounts adding up to the amount; when_done waits to be marked done. Months already posted are caught up in the next month (caughtUp says so). tracking and customFields go on each month's income or expense line; Spread this starts from the line's own tracking.",
    level: "post",
    input: {
      kind: KIND,
      description: { type: "string", maxLength: 200 },
      amount: MONEY,
      targetAccountCode: { type: "string" },
      method: { type: "string", enum: [...SPREAD_METHODS] },
      startDate: DATE,
      endDate: DATE,
      month: MONTH,
      ownAmounts: { type: "array", maxItems: 120, items: { type: "object", properties: { month: MONTH, amount: MONEY }, required: ["month", "amount"], additionalProperties: false } },
      contactId: ID("contact"),
      ...TAGS,
      ...LINE_IDS,
    },
    required: [],
    act: (tx, args, command) => createSpreadItem(tx, { ...args, ...command }),
  }),
  tool({
    name: "dismiss_spreading_suggestion",
    title: "Dismiss a Spreading suggestion",
    description: "Says one of get_spreading_suggestions' suggestions isn't wanted, so it doesn't come back. Nothing in the books changes.",
    level: "post",
    input: { key: { type: "string", description: "The suggestion's key from get_spreading_suggestions." } },
    required: ["key"],
    act: async (tx, args) => {
      await dismissSpreadSuggestion(tx, { key: args.key });
      return { dismissed: args.key };
    },
  }),
  tool({
    name: "post_spreading_month",
    title: "Post a Spreading month",
    description:
      "Month end on the Spreading worksheet: posts one kind's month as one journal dated the month's last day (check preview_spreading_month first). Months go in order; a locked month is refused and isn't moved.",
    level: "post",
    input: { kind: KIND, month: MONTH, customFields: { type: "object", additionalProperties: true, description: "Custom fields of the journal itself (used on journals), field id to value. Left out, they take their defaults." } },
    required: ["kind", "month"],
    act: (tx, args, command) => postSpreadMonth(tx, { ...command, kind: args.kind, month: args.month, ...(args.customFields !== undefined ? { customFields: args.customFields } : {}) }),
  }),
  tool({
    name: "update_spreading_item_tags",
    title: "Change a Spreading item's tracking and custom fields",
    description: "Sets the tracking and journal-line custom fields an item puts on each month's income or expense line. Applies to months not yet posted; send the whole set for whichever of the two you change.",
    level: "post",
    input: { itemId: ID("worksheet item"), ...TAGS },
    required: ["itemId"],
    act: (tx, args) => {
      const { itemId, ...body } = args;
      return updateSpreadItemTags(tx, itemId, body);
    },
  }),
  tool({
    name: "end_spreading_item_early",
    title: "End a Spreading item early",
    description: "End early on a paid-in-advance or income-in-advance item: what's left lands in one month. Posted months don't change.",
    level: "post",
    input: { itemId: ID("worksheet item"), month: MONTH },
    required: ["itemId", "month"],
    act: (tx, args) => endSpreadItemEarly(tx, args.itemId, { month: args.month }),
  }),
  tool({
    name: "mark_spreading_item_done",
    title: "Mark a Spreading item done",
    description: "Mark done on a \"when it's done\" item: all of it lands in that month.",
    level: "post",
    input: { itemId: ID("worksheet item"), month: MONTH },
    required: ["itemId", "month"],
    act: (tx, args) => markSpreadItemDone(tx, args.itemId, { month: args.month }),
  }),
  tool({
    name: "mark_spreading_accrual_arrived",
    title: "Mark an accrual's bill or invoice as arrived",
    description:
      "Bill arrived or Invoice sent on an accrual: the months not yet posted are dropped and what it came to over or under goes in that month's journal. Either give month and amount (without GST) when the bill or invoice was coded to the accrual account, or give one line id (from get_spreadable_lines) to use that line's amount and move it there.",
    level: "post",
    input: { itemId: ID("worksheet item"), month: MONTH, amount: MONEY, ...LINE_IDS },
    required: ["itemId"],
    act: (tx, args) => {
      const { itemId, ...body } = args;
      return settleSpreadItem(tx, itemId, body);
    },
  }),
  tool({
    name: "undo_spreading_month",
    title: "Undo a Spreading month",
    description: "Undo on a kind's latest posted month: its journal is reversed on the same date and its amounts wait to be posted again. runId is in get_spreading_worksheet's posted.",
    level: "full",
    input: { runId: ID("posted month") },
    required: ["runId"],
    shows: (tx, args) => getSpreadRun(tx, args.runId),
    act: (tx, args, command) => undoSpreadRun(tx, args.runId, command),
  }),
  tool({
    name: "undo_spreading_accrual_arrived",
    title: "Undo an accrual's bill or invoice arriving",
    description: "Undoes Bill arrived or Invoice sent on an accrual, until its difference has posted: the dropped months come back and a move from a bill, invoice or bank line is reversed.",
    level: "full",
    input: { itemId: ID("worksheet item") },
    required: ["itemId"],
    shows: (tx, args) => getSpreadItem(tx, args.itemId),
    act: (tx, args) => unsettleSpreadItem(tx, args.itemId),
  }),
  tool({
    name: "remove_spreading_item",
    title: "Remove a Spreading item",
    description: "Remove on a worksheet item that has had no month posted. One made with Spread this has its move reversed, so the amount is back on the bill's or invoice's own account.",
    level: "full",
    input: { itemId: ID("worksheet item") },
    required: ["itemId"],
    shows: (tx, args) => getSpreadItem(tx, args.itemId),
    act: async (tx, args) => {
      await removeSpreadItem(tx, args.itemId);
      return { removed: true };
    },
  }),
];
