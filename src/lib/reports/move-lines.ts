import type { CashFlowLayout, CashFlowRow, EquityLayout } from "@/lib/reports/custom-layout";

/*
 * Moving a line on a Cash flows or Changes in equity layout: from the group it's in to another group, or to another place in
 * its own, in one step. A line is in at most one group, so it is taken out
 * of wherever it was. Nothing here changes a figure: a line's amount is the
 * same wherever it sits, and a line in no group still falls back to its
 * usual place (CFL2, CEL2). Browser-safe.
 */

export type LineGroup = { id: string; label: string };

type Group = Extract<CashFlowRow, { kind: "group" }>;

function cashFlowGroupRows(layout: CashFlowLayout): Array<{ group: Group; section: string }> {
  return layout.blocks.flatMap((block) => (block.kind === "section" ? block.rows.flatMap((row) => (row.kind === "group" ? [{ group: row, section: block.title }] : [])) : []));
}

function equityGroupRows(layout: EquityLayout): Group[] {
  return layout.blocks.flatMap((block) => (block.kind === "group" ? [block] : []));
}

/** Every group a line could go to, named with its section so two "Other" groups can be told apart. */
export function cashFlowGroups(layout: CashFlowLayout): LineGroup[] {
  return cashFlowGroupRows(layout).map(({ group, section }) => ({ id: group.id, label: `${section} › ${group.label}` }));
}

export function equityGroups(layout: EquityLayout): LineGroup[] {
  return equityGroupRows(layout).map((group) => ({ id: group.id, label: group.label }));
}

/**
 * Puts `ref` in the group `toGroupId`: before the line `before` when that
 * line is in the group, otherwise at the end. Returns false, changing
 * nothing, when the group isn't there or the line would land where it is.
 */
function moveWithin(groups: Group[], ref: string, toGroupId: string, before: string | null): boolean {
  const target = groups.find((group) => group.id === toGroupId);
  if (!target || before === ref) return false;
  const was = target.lines.indexOf(ref);
  const wanted = before !== null && target.lines.includes(before) ? target.lines.filter((line) => line !== ref).indexOf(before) : target.lines.filter((line) => line !== ref).length;
  if (was !== -1 && was === wanted) return false;
  for (const group of groups) group.lines = group.lines.filter((line) => line !== ref);
  target.lines.splice(wanted, 0, ref);
  return true;
}

/** Changes `layout` in place; true when anything moved. */
export function moveCashFlowLine(layout: CashFlowLayout, ref: string, toGroupId: string, before: string | null = null): boolean {
  return moveWithin(
    cashFlowGroupRows(layout).map((entry) => entry.group),
    ref,
    toGroupId,
    before,
  );
}

export function moveEquityLine(layout: EquityLayout, ref: string, toGroupId: string, before: string | null = null): boolean {
  return moveWithin(equityGroupRows(layout), ref, toGroupId, before);
}

/** One place up or down within its own group; false at the top or bottom. */
export function stepLine(lines: string[], ref: string, by: -1 | 1): string[] | null {
  const at = lines.indexOf(ref);
  const to = at + by;
  if (at === -1 || to < 0 || to >= lines.length) return null;
  const next = [...lines];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}
