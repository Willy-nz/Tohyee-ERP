import { type ExtraPayMethod } from "@/lib/payroll/calculations";
import type { PayFrequency } from "@/lib/payroll/groups";
import {
type EmployeePayResult,
type KiwiSaverStatus
} from "@/lib/payroll/pay-calculation";
import {
type PayItemCategory,
type PayItemKind
} from "@/lib/payroll/pay-items";
import { type TrackingTags } from "@/lib/tracking/service";

/**
 * Pay runs (examples PRUN1-PRUN11, payroll stage P3). A pay run pays one
 * pay group for one pay period on one pay date. A draft has a line per
 * employee from their pay rate; people running pay add earnings and
 * deductions; pay is calculated with IRD's rates for the pay date
 *. Approving posts one journal dated the pay date, with each
 * employee's costs split by their approved timesheets for the days they
 * cover and their cost allocation on the pay date for the rest (P9), and the
 * journal lines totalled by pay item, account and tracking, never by
 * employee. Approved pay runs are never changed, only voided
 * (an exact reversing journal). Everything needs payroll access.
 *
 * Extra pays (bonuses, back pay, holiday pay on finishing, redundancy) are
 * lines taxed under IRD's extra pay rules against the four weeks' pay or,
 * on a final pay, the last 2 paid periods (P12).
 */

export type PayRunStatus = "draft" | "approved" | "voided";

export type PayRunLine = {
  lineNumber: number;
  payItemId: string;
  payItemName: string;
  category: PayItemCategory;
  kind: PayItemKind;
  quantity: string | null;
  rate: string | null;
  amount: string;
  description: string | null;
  /** Back pay worked out from pay rate history: the approved pay run it's for. */
  backPayForPayRunId: string | null;
  /** Typed, the usual pay Tohyee made from the usual week, or leave Tohyee worked out (P8). */
  source: "typed" | "usual_pay" | "leave";
  /** Overtime or an allowance that's a regular part of pay (s 8(1)(b)). */
  regular: boolean | null;
  /** Leave Tohyee worked out: what, when, how much and the rate's inputs. */
  leave: PayRunLeave | null;
};

export type PayRunLeave = {
  type: string;
  from: string | null;
  to: string | null;
  hours: string | null;
  units: string | null;
  inAdvance: boolean;
  holidayDate: string | null;
  basis: Record<string, unknown>;
};

/** How an employee's extra pays are taxed: kept when approved. */
export type ExtraPayBasis = {
  method: ExtraPayMethod | "flat_rate";
  /** The annualised income, or null for a flat rate. */
  annualised: string | null;
};

export type PayRunEmployee = {
  employeeId: string;
  name: string;
  taxCode: string;
  studentLoan: boolean;
  kiwiSaverStatus: KiwiSaverStatus;
  kiwiSaverEmployeeRate: string;
  kiwiSaverEmployerRate: string;
  esctRate: string | null;
  /** The hourly rate overtime defaults from, or null for salaried employees. */
  hourlyRate: string | null;
  lines: PayRunLine[];
  /** Null when the pay can't be calculated; `problem` says why (PRUN8). */
  pay: EmployeePayResult | null;
  problem: string | null;
  /** Approved timesheets covering the period (live on a draft, as used once approved; TS5, TS6). */
  timesheets: PayRunTimesheets | null;
  /** The employee's finish date when this is their final pay. */
  finishDate: string | null;
  /** How the extra pays were (or will be) taxed, or null with none. */
  extraPayBasis: ExtraPayBasis | null;
  /** What the person running pay should know: a final pay, how extra pays are taxed (XP8, XP12). */
  notes: string[];
};

export type PayRunTimesheets = {
  count: number;
  coveredDays: number;
  periodDays: number;
  hours: string;
  allDaysCovered: boolean;
};

export type PayRunTotals = {
  gross: string;
  paye: string;
  studentLoan: string;
  kiwiSaverEmployee: string;
  deductions: string;
  netPay: string;
  kiwiSaverEmployer: string;
  esct: string;
  employerCost: string;
};

export type PayRunSummary = {
  id: string;
  reference: string;
  payGroupId: string;
  payGroupName: string;
  payFrequency: PayFrequency;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: PayRunStatus;
  employeeCount: number;
  createdByEmail: string;
  approvedByEmail: string | null;
  approvedAt: string | null;
  voidDate: string | null;
  voidedByEmail: string | null;
};

export type PayRun = PayRunSummary & {
  approvalJournalId: string | null;
  voidJournalId: string | null;
  /** False when approved while Accounting was off (PAO3): it never posts. */
  inBooks: boolean;
  /** True if the signed-in person created or changed the draft (PRUN7). */
  preparedByMe: boolean;
  approverMustDiffer: boolean;
  employees: PayRunEmployee[];
  /** Totals of everyone whose pay could be calculated. */
  totals: PayRunTotals;
  problemCount: number;
};

// Creating a draft

export type GroupEmployee = {
  id: string;
  name: string;
  start_date: string;
  finish_date: string | null;
};

export type PayRunPosting = {
  postingNumber: number;
  employeeId: string;
  employeeName: string;
  payItemName: string;
  /** None for a pay run approved without the books when its pay item has no account (PAO7). */
  accountCode: string | null;
  tracking: TrackingTags;
  projectId: string | null;
  percentage: string;
  amount: string;
  /** None without the books: there's no journal (PAO7). */
  journalLineOrder: number | null;
};
