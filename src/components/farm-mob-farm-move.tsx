"use client";

import { useState } from "react";
import { BigNumber, Choices, DayChoice, Step } from "@/components/farm-log";
import { useApiData } from "@/components/hooks";
import { submitThroughQueue, useOfflineQueue } from "@/components/offline-queue";
import { Notice, ui } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import type { Animal } from "@/lib/farming/animals";
import { shortDate } from "@/lib/farming/farm-words";
import type { FarmMoveResult } from "@/lib/farming/mob-farm-move";
import { farmMoveName, farmMoveWarning, naitReminder } from "@/lib/farming/mob-rules";
import type { Mob } from "@/lib/farming/mobs";
import type { Farm } from "@/lib/farming/paddocks";
import { todayInBrowser } from "@/lib/format";
import { newOperationId } from "@/lib/offline/queue";
import styles from "./farm-workspace.module.css";

/*
 * Move to another farm (OPF7-OPF13): three steps on a phone. Which farm, how many (and which tags, for
 * part of a tagged mob), then which mob there and the day. It's a move, not a sale, so the books' head
 * count doesn't change; the withholding goes with the animals and the step warns before it's saved. It
 * goes through the device's queue, so it keeps with no signal and a resend records it once.
 */

const NATURAL = new Intl.Collator("en-NZ", { numeric: true, sensitivity: "base" });

/** The farms a mob can go to: the others in use. */
export function otherFarms(farms: Farm[], farmId: string): Farm[] {
  return farms.filter((entry) => entry.isActive && entry.id !== farmId).sort((a, b) => NATURAL.compare(a.name, b.name));
}

export function FarmMoveFlow({ organisationId, farm, farms, mob, onClose }: { organisationId: string; farm: Farm; farms: Farm[]; mob: Mob; onClose: (message: string | null) => void }) {
  const today = todayInBrowser();
  const { queue } = useOfflineQueue(organisationId);
  const choices = otherFarms(farms, farm.id);
  const [index, setIndex] = useState(0);
  const [toFarmId, setToFarmId] = useState<string | null>(choices.length === 1 ? choices[0].id : null);
  const [all, setAll] = useState<boolean | null>(null);
  const [head, setHead] = useState("");
  const [animalIds, setAnimalIds] = useState<string[]>([]);
  const [intoMobId, setIntoMobId] = useState<string>("__new");
  const [day, setDay] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toFarm = choices.find((entry) => entry.id === toFarmId) ?? null;
  // Mobs there need a signal; with none, a new mob is still offered.
  const there = useApiData<{ mobs: Mob[] }>(index === 2 && toFarmId ? `/api/farming/farms/${toFarmId}/mobs` : null, { organisationId });
  const tagged = useApiData<{ animals: Animal[] }>(mob.tagged > 0 && all === false ? `/api/farming/farms/${farm.id}/animals` : null, { organisationId, mobId: mob.id });
  const count = all ? mob.head : Number(head.replace(/,/g, "")) || 0;
  const countOk = all === true || (/^\d{1,6}$/.test(head.replace(/,/g, "")) && count >= 1 && count <= mob.head);
  const staying = mob.tagged - animalIds.length;
  const short = all ? 0 : Math.max(0, staying - (mob.head - count));
  const sameClass = (there.data?.mobs ?? []).filter((entry) => entry.status === "active" && entry.kind === mob.kind && entry.classCode === mob.classCode);
  const warning = toFarm ? farmMoveWarning(mob.withholding, day, toFarm.name, (iso) => shortDate(iso, today)) : null;
  const nait = naitReminder(mob.kind);
  const frame = { title: `Move to another farm · ${mob.name}`, step: index + 1, steps: 3, onBack: () => (index === 0 ? onClose(null) : setIndex(index - 1)) };

  const save = async () => {
    if (!toFarm) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { farmId: farm.id, toFarmId: toFarm.id, onDate: day, head: count };
    if (intoMobId !== "__new") body.intoMobId = intoMobId;
    if (!all && animalIds.length) body.animalIds = animalIds;
    try {
      const outcome = await submitThroughQueue(queue, {
        operationId: newOperationId(),
        kind: "mob.farm_move",
        label: `Move ${count} to ${toFarm.name}: ${mob.name}`,
        farmId: farm.id,
        farmName: farm.name,
        request: { method: "POST", path: `/api/farming/mobs/${mob.id}/farm-move`, body },
      });
      onClose(outcome.state === "synced" ? ((outcome.result as FarmMoveResult | undefined)?.message ?? "Moved.") : "Kept on this device. It goes when Tohyee can be reached.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!choices.length) {
    return (
      <Step {...frame} question="Which farm are they going to?">
        <p>There&apos;s no other farm you work on. A farm needs adding first, in Farm settings.</p>
      </Step>
    );
  }

  if (index === 0) {
    return (
      <Step {...frame} question="Which farm are they going to?" onNext={() => setIndex(1)} nextDisabled={!toFarm}>
        <Choices options={choices.map((entry) => ({ value: entry.id, label: entry.name }))} value={toFarmId} onPick={(value) => {
            setToFarmId(value);
            setIndex(1);
          }} />
        <p className={ui.muted}>A move between your own farms, not a sale. The books&apos; head count stays the same.</p>
      </Step>
    );
  }

  if (index === 1) {
    const list = [...(tagged.data?.animals ?? [])].sort((a, b) => NATURAL.compare(a.tag, b.tag));
    return (
      <Step {...frame} question={`How many go to ${toFarm?.name ?? "the other farm"}?`} onNext={() => setIndex(2)} nextDisabled={!countOk || short > 0 || animalIds.length > count}>
        <Choices
          options={[
            { value: "all", label: `All ${mob.head.toLocaleString("en-NZ")}` },
            { value: "some", label: "Some of them" },
          ]}
          value={all === null ? null : all ? "all" : "some"}
          onPick={(value) => {
            setAll(value === "all");
            if (value === "all") setIndex(2);
          }}
        />
        {all === false ? <BigNumber label="How many" unit="head" value={head} onChange={setHead} /> : null}
        {all === false && head && !countOk ? <Notice tone="warning">{mob.name} has {mob.head} head. Enter 1 to {mob.head}.</Notice> : null}
        {all === false && mob.tagged > 0 ? (
          <>
            <p className={ui.muted} style={{ margin: 0 }}>Tick the tagged animals that go. They move onto {toFarm?.name}&apos;s register.</p>
            {short > 0 ? <Notice tone="warning">{mob.head - count} head would stay but {staying} tagged. Tick at least {short} more.</Notice> : null}
            {tagged.error ? <Notice tone="error">{tagged.error}</Notice> : null}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 6 }}>
              {list.map((animal) => {
                const on = animalIds.includes(animal.id);
                return (
                  <label key={animal.id} className={styles.check} style={{ minHeight: 44 }}>
                    <input type="checkbox" checked={on} onChange={() => setAnimalIds(on ? animalIds.filter((id) => id !== animal.id) : [...animalIds, animal.id])} /> {animal.tag}
                  </label>
                );
              })}
            </div>
          </>
        ) : null}
      </Step>
    );
  }

  return (
    <Step {...frame} question={`Into which mob on ${toFarm?.name}?`} onNext={() => void save()} nextLabel={busy ? "Moving…" : `Move ${count.toLocaleString("en-NZ")} to ${toFarm?.name}`} nextDisabled={busy}>
      {error ? <Notice tone="error">Not moved: {error}</Notice> : null}
      {warning ? <Notice tone="warning">{warning}</Notice> : null}
      <Choices
        options={[
          { value: "__new", label: "A new mob", note: toFarm ? farmMoveName(mob.name, farm.name) : undefined },
          ...sameClass.map((entry) => ({ value: entry.id, label: entry.name, note: `${entry.head.toLocaleString("en-NZ")} head` })),
        ]}
        value={intoMobId}
        onPick={setIntoMobId}
      />
      {there.error ? <p className={ui.muted}>Can&apos;t see {toFarm?.name}&apos;s mobs with no signal. A new mob still works.</p> : null}
      <DayChoice value={day} onChange={setDay} />
      {nait ? <Notice tone="info">{nait}</Notice> : null}
    </Step>
  );
}
