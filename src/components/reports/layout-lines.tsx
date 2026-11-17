"use client";

import { useState } from "react";
import { Button, ui } from "@/components/ui";
import type { LineGroup } from "@/lib/reports/move-lines";

/**
 * A group's lines on the Cash flows and Changes in equity layout editors
 *. Each line can be dragged onto another line or
 * group (in any section), stepped up or down, sent with "Move to" for the
 * keyboard and touch, or taken out, in one step each.
 */

/** The line being dragged. Held here because a drag's own data can't be read until the drop. */
const dragged: { ref: string | null } = { ref: null };
function hold(ref: string | null) {
  dragged.ref = ref;
}

export function LayoutLines({
  groupId,
  lines,
  labelOf,
  groups,
  onMove,
  onStep,
  onTakeOut,
}: {
  groupId: string;
  lines: string[];
  labelOf: (ref: string) => string;
  /** Every group on the layout, this one included. */
  groups: LineGroup[];
  onMove: (ref: string, toGroupId: string, before: string | null) => void;
  onStep: (ref: string, by: -1 | 1) => void;
  onTakeOut: (ref: string) => void;
}) {
  // Where a drop would land: a line's ref (before it), "end", or nothing.
  const [over, setOver] = useState<string | null>(null);
  const others = groups.filter((group) => group.id !== groupId);
  const allow = (event: React.DragEvent, target: string) => {
    if (!dragged.ref || dragged.ref === target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (over !== target) setOver(target);
  };
  const drop = (event: React.DragEvent, before: string | null) => {
    const ref = dragged.ref;
    hold(null);
    setOver(null);
    if (!ref || ref === before) return;
    event.preventDefault();
    onMove(ref, groupId, before);
  };
  const mark = (target: string): React.CSSProperties => (over === target ? { boxShadow: "0 -2px 0 var(--accent, #2563eb)" } : {});

  return (
    <div style={{ display: "grid", gap: 6 }} onDragLeave={(event) => (event.currentTarget.contains(event.relatedTarget as Node | null) ? undefined : setOver(null))}>
      {lines.map((ref, index) => (
        <div key={ref} className={ui.rowButtons} style={{ alignItems: "center", ...mark(ref) }} onDragOver={(event) => allow(event, ref)} onDrop={(event) => drop(event, ref)}>
          <span
            draggable
            role="img"
            aria-label={`Drag ${labelOf(ref)}`}
            title="Drag to another place or group"
            style={{ cursor: "grab", userSelect: "none", padding: "0 4px", color: "var(--text-muted)" }}
            onDragStart={(event) => {
              hold(ref);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", labelOf(ref));
            }}
            onDragEnd={() => {
              hold(null);
              setOver(null);
            }}
          >
            ⠿
          </span>
          <span style={{ flex: "1 1 auto", minWidth: 0 }}>{labelOf(ref)}</span>
          <Button size="small" variant="secondary" disabled={index === 0} aria-label={`Move ${labelOf(ref)} up`} onClick={() => onStep(ref, -1)}>
            ↑
          </Button>
          <Button size="small" variant="secondary" disabled={index === lines.length - 1} aria-label={`Move ${labelOf(ref)} down`} onClick={() => onStep(ref, 1)}>
            ↓
          </Button>
          {others.length ? (
            <select
              aria-label={`Move ${labelOf(ref)} to another group`}
              style={{ width: "auto", flex: "0 0 auto", maxWidth: 220 }}
              value=""
              onChange={(event) => {
                if (event.target.value) onMove(ref, event.target.value, null);
              }}
            >
              <option value="">Move to…</option>
              {others.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.label}
                </option>
              ))}
            </select>
          ) : null}
          <Button size="small" variant="secondary" onClick={() => onTakeOut(ref)}>
            Take out
          </Button>
        </div>
      ))}
      {/* Somewhere to drop at the end of the group, and into an empty one. */}
      <div
        style={{ minHeight: lines.length ? 10 : 28, borderRadius: 4, ...(over === "end" ? { outline: "2px dashed var(--accent, #2563eb)" } : {}) }}
        className={lines.length ? undefined : ui.muted}
        onDragOver={(event) => allow(event, "end")}
        onDrop={(event) => drop(event, null)}
      >
        {lines.length ? null : "No lines yet. Drag one here, or choose one below."}
      </div>
    </div>
  );
}
