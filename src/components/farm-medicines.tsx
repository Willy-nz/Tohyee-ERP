"use client";

import Link from "next/link";
import { useState } from "react";
import { DateInput } from "@/components/date-input";
import { Choices } from "@/components/farm-log";
import { useCanRecordFarmWork } from "@/components/farm-selector";
import type { FarmContext } from "@/components/farm-workspace";
import { useApiData } from "@/components/hooks";
import { MedicineArt } from "@/components/medicine-art";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { BADGE_LABELS, MEDICINE_KIND_KEYS, MEDICINE_KINDS, type MedicineKind, STARTER_LIST_LABELS, STARTER_LISTS, type StarterList } from "@/lib/farming/medicine-rules";
import type { CabinetSlot } from "@/lib/farming/medicines";
import { STOCK_UNITS, type StockUnit } from "@/lib/farming/treatment-rules";
import { shortDate } from "@/lib/farming/farm-words";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { SafetyFile } from "@/lib/safety/files";
import styles from "./farm-medicines.module.css";

/*
 * The medicine cabinet (MED1-MED10): each farm's medicines on a vending
 * machine's shelves, with what's on hand. Tap one to record stock, move it to
 * another farm, set its reorder level or photo.
 */

type Cabinet = { slots: CabinetSlot[]; canManage: boolean };

const fileUrl = (organisationId: string, fileId: string) => `/api/farming/safety/files/${fileId}?organisationId=${encodeURIComponent(organisationId)}`;

function amount(slot: CabinetSlot): string {
  if (slot.onHand === null) return "None recorded";
  const unit = slot.unit === "each" ? "" : ` ${slot.unit}`;
  return `${slot.onHand}${unit}`;
}

export function FarmMedicines({ organisationId, farm, farms }: FarmContext) {
  const data = useApiData<Cabinet>("/api/farming/medicines", { organisationId, farmId: farm.id });
  const [chosen, setChosen] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const slots = data.data?.slots ?? [];
  const canManage = data.data?.canManage ?? false;
  const slot = slots.find((entry) => entry.chemicalRecordId === chosen) ?? null;
  const low = slots.filter((entry) => entry.badge === "low" || entry.badge === "out").length;
  const expiring = slots.filter((entry) => entry.expiry === "expired" || entry.expiry === "soon").length;
  const reload = () => data.reload();
  return (
    <div className={ui.stack}>
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      <section className={styles.machine} aria-label={`${farm.name} medicine cabinet`}>
        <header className={styles.marquee}>
          <div className={styles.marqueeIdentity}>
            <div className={styles.marqueeText}>
              <span className={styles.marqueeEyebrow}>Farm supplies / medicine cabinet</span>
              <h2>{farm.name}</h2>
            </div>
          </div>
          <div className={styles.machineStats} aria-label="Cabinet summary">
            <span className={styles.totalStat}><strong>{slots.length}</strong> products</span>
            {low ? <span className={styles.attentionStat}><strong>{low}</strong> low or out</span> : null}
            {expiring ? <span className={styles.expiryStat}><strong>{expiring}</strong> expiry alerts</span> : null}
          </div>
        </header>
        <div className={styles.glass}>
          <div className={styles.glassTop} aria-hidden="true">
            <span>Stock on hand</span>
            <span>SELECT A PRODUCT TO UPDATE</span>
          </div>
          {data.data && !slots.length ? (
            <p className={styles.empty}>Nothing in the cabinet yet.{canManage ? " Start from the common list below." : " Ask a bookkeeper or owner to set it up."}</p>
          ) : null}
          <ul className={styles.shelves}>
            {slots.map((entry, index) => (
              <li key={entry.chemicalRecordId}>
                <button
                  type="button"
                  className={`${styles.slot} ${chosen === entry.chemicalRecordId ? styles.chosen : ""} ${entry.badge === "out" ? styles.out : ""}`}
                  onClick={() => setChosen(chosen === entry.chemicalRecordId ? null : entry.chemicalRecordId)}
                  aria-pressed={chosen === entry.chemicalRecordId}
                  aria-label={`${entry.name}, ${amount(entry)} on hand${entry.badge === "ok" || entry.badge === "none" ? "" : `, ${BADGE_LABELS[entry.badge]}`}${entry.expiry === "expired" ? ", expired" : entry.expiry === "soon" ? ", expires soon" : ""}. ${chosen === entry.chemicalRecordId ? "Close details" : "Open details"}`}
                >
                  <span className={styles.slotNumber} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <span className={styles.picture}>
                    {entry.photoFileId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={fileUrl(organisationId, entry.photoFileId)} alt="" />
                    ) : (
                      <MedicineArt shape={MEDICINE_KINDS[entry.kind].shape} colour={MEDICINE_KINDS[entry.kind].colour} />
                    )}
                  </span>
                  <span className={styles.coil} aria-hidden="true" />
                  <span className={styles.name}>{entry.name}</span>
                  <span className={styles.stockLabel}>On hand</span>
                  <span className={styles.price}>{amount(entry)}</span>
                  <span className={styles.badges}>
                    {entry.badge === "low" ? <Badge tone="amber">{BADGE_LABELS.low}</Badge> : null}
                    {entry.badge === "out" ? <Badge tone="red">{BADGE_LABELS.out}</Badge> : null}
                    {entry.badge === "count" ? <Badge tone="red">{BADGE_LABELS.count}</Badge> : null}
                    {entry.expiry === "expired" ? <Badge tone="red">Expired</Badge> : null}
                    {entry.expiry === "soon" && entry.expiresOn ? <Badge tone="amber">Expires {shortDate(entry.expiresOn, todayInBrowser())}</Badge> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.machineFooter} aria-hidden="true">
          <span className={styles.machineLight} />
          <span className={styles.machineFooterLabel}>STOCK CONTROL</span>
          <span className={styles.tray} />
          <span className={styles.machineFooterLabel}>TOHYEE · FARM</span>
        </div>
      </section>

      {slot ? <SlotPanel key={slot.chemicalRecordId} organisationId={organisationId} farmId={farm.id} farms={farms} slot={slot} canManage={canManage} onDone={reload} onRemoved={() => (setChosen(null), reload())} /> : null}

      {canManage ? (
        <Card title="Add medicines">
          {setup ? <StarterForm organisationId={organisationId} farmId={farm.id} have={new Set(slots.map((entry) => entry.kind))} onDone={() => (setSetup(false), reload())} /> : (
            <Button variant="secondary" onClick={() => setSetup(true)}>
              Start from the common list
            </Button>
          )}
          <AddForm organisationId={organisationId} farmId={farm.id} onDone={reload} />
        </Card>
      ) : null}
    </div>
  );
}

function StarterForm({ organisationId, farmId, have, onDone }: { organisationId: string; farmId: string; have: Set<MedicineKind>; onDone: () => void }) {
  const [list, setList] = useState<StarterList>("dairy");
  const [ticked, setTicked] = useState<Set<MedicineKind>>(new Set(STARTER_LISTS.dairy));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = (next: StarterList) => {
    setList(next);
    setTicked(new Set(STARTER_LISTS[next]));
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/farming/medicines/starter", { method: "POST", body: { organisationId, farmId, list, kinds: STARTER_LISTS[list].filter((kind) => ticked.has(kind)) } });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={ui.stack}>
      <Choices options={(Object.keys(STARTER_LISTS) as StarterList[]).map((value) => ({ value, label: STARTER_LIST_LABELS[value] }))} value={list} onPick={pick} />
      <p className={ui.muted}>Untick what you don&apos;t keep. Each one is added named after its kind: rename it to the product you use. Withholding periods come from each product&apos;s label when you treat.</p>
      <div className={styles.ticks}>
        {STARTER_LISTS[list].map((kind) => (
          <label key={kind} className={ui.checkbox}>
            <input
              type="checkbox"
              disabled={have.has(kind)}
              checked={have.has(kind) || ticked.has(kind)}
              onChange={(event) =>
                setTicked((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(kind);
                  else next.delete(kind);
                  return next;
                })
              }
            />
            <MedicineArt shape={MEDICINE_KINDS[kind].shape} colour={MEDICINE_KINDS[kind].colour} size={28} /> {MEDICINE_KINDS[kind].label}
            {have.has(kind) ? <span className={ui.muted}> (in the cabinet)</span> : null}
          </label>
        ))}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button disabled={busy} onClick={() => void save()}>
        Add to the cabinet
      </Button>
    </div>
  );
}

function AddForm({ organisationId, farmId, onDone }: { organisationId: string; farmId: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MedicineKind>("other");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      await api("/api/farming/medicines", { method: "POST", body: { organisationId, farmId, name: name.trim(), kind } });
      setName("");
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <form
      className={ui.inlineForm}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label="Product name">
        <input value={name} maxLength={150} onChange={(event) => setName(event.target.value)} />
      </Field>
      <KindSelect value={kind} onChange={setKind} />
      <Button type="submit" variant="secondary" disabled={!name.trim()}>
        Add
      </Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </form>
  );
}

function KindSelect({ value, onChange }: { value: MedicineKind; onChange: (kind: MedicineKind) => void }) {
  return (
    <Field label="Kind">
      <select value={value} onChange={(event) => onChange(event.target.value as MedicineKind)}>
        {MEDICINE_KIND_KEYS.map((key) => (
          <option key={key} value={key}>
            {MEDICINE_KINDS[key].label}
          </option>
        ))}
      </select>
    </Field>
  );
}

type Action = "received" | "used" | "counted" | "disposed" | "move";

function SlotPanel({ organisationId, farmId, farms, slot, canManage, onDone, onRemoved }: { organisationId: string; farmId: string; farms: FarmContext["farms"]; slot: CabinetSlot; canManage: boolean; onDone: () => void; onRemoved: () => void }) {
  const canRecord = useCanRecordFarmWork();
  const others = farms.filter((farm) => farm.id !== farmId);
  const defaultUnit = (STOCK_UNITS as readonly string[]).includes(slot.unit ?? "") ? (slot.unit as StockUnit) : MEDICINE_KINDS[slot.kind].unit;
  const [action, setAction] = useState<Action>("used");
  const [form, setForm] = useState({ quantity: "", unit: defaultUnit as StockUnit, movedOn: todayInBrowser(), batch: "", expiresOn: "", note: "", toFarmId: others[0]?.id ?? "" });
  const [settings, setSettings] = useState({ name: slot.name, kind: slot.kind, reorderAt: slot.reorderAt ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onDone();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const record = () =>
    run(async () => {
      if (action === "move") {
        await api(`/api/farming/medicines/${slot.chemicalRecordId}/move`, { method: "POST", body: { organisationId, toFarmId: form.toFarmId, quantity: form.quantity, unit: form.unit, movedOn: form.movedOn, note: form.note || null } });
      } else {
        await api("/api/farming/product-stock", {
          method: "POST",
          body: { organisationId, chemicalRecordId: slot.chemicalRecordId, movementType: action, quantity: form.quantity, unit: form.unit, movedOn: form.movedOn, batch: form.batch || null, expiresOn: form.expiresOn || null, note: form.note || null },
        });
      }
      setForm({ ...form, quantity: "", batch: "", expiresOn: "", note: "" });
    });
  const saveSettings = () =>
    run(() => api(`/api/farming/medicines/${slot.chemicalRecordId}`, { method: "PATCH", body: { organisationId, name: settings.name.trim(), kind: settings.kind, reorderAt: settings.reorderAt.trim() || null } }));
  const setPhoto = async (file: File | null) => {
    if (!file) return;
    await run(async () => {
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
      const uploaded = (await api<{ file: SafetyFile }>("/api/farming/safety/files", { method: "POST", body: { organisationId, farmId, fileName: file.name, contentType: file.type, contentBase64: btoa(binary), phoneFileTime: new Date(file.lastModified).toISOString() } })).file;
      await api(`/api/farming/medicines/${slot.chemicalRecordId}`, { method: "PATCH", body: { organisationId, photoFileId: uploaded.id } });
    });
  };
  const remove = async () => {
    if (await run(() => api(`/api/farming/medicines/${slot.chemicalRecordId}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" }))) onRemoved();
  };
  const actions: Array<{ value: Action; label: string }> = [
    { value: "used", label: "Used" },
    { value: "received", label: "Received" },
    { value: "counted", label: "Counted" },
    { value: "disposed", label: "Thrown out" },
    ...(others.length ? [{ value: "move" as const, label: "Move to a farm" }] : []),
  ];
  return (
    <Card title={slot.name} description={`${MEDICINE_KINDS[slot.kind].label === slot.name ? "" : `${MEDICINE_KINDS[slot.kind].label} · `}${amount(slot)} on hand${slot.lastCountedOn ? ` · counted ${formatDate(slot.lastCountedOn)}` : ""}${slot.location ? ` · kept in ${slot.location}` : ""}`}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {canRecord ? (
        <div className={ui.stack}>
          <Choices options={actions} value={action} onPick={setAction} />
          <div className={ui.inlineForm}>
            <Field label={action === "counted" ? "How much is there" : "How much"}>
              <input inputMode="decimal" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
            </Field>
            <Field label="Unit">
              <select value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value as StockUnit })}>
                {STOCK_UNITS.map((unit) => (
                  <option key={unit}>{unit}</option>
                ))}
              </select>
            </Field>
            <Field label="Date">
              <DateInput value={form.movedOn} onChange={(event) => setForm({ ...form, movedOn: event.target.value })} />
            </Field>
            {action === "move" ? (
              <Field label="To">
                <select value={form.toFarmId} onChange={(event) => setForm({ ...form, toFarmId: event.target.value })}>
                  {others.map((farm) => (
                    <option key={farm.id} value={farm.id}>
                      {farm.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {action === "received" || action === "counted" ? (
              <>
                <Field label="Batch">
                  <input value={form.batch} maxLength={60} onChange={(event) => setForm({ ...form, batch: event.target.value })} />
                </Field>
                <Field label="Expiry date">
                  <DateInput value={form.expiresOn} onChange={(event) => setForm({ ...form, expiresOn: event.target.value })} />
                </Field>
              </>
            ) : null}
            <Field label="Note">
              <input value={form.note} maxLength={200} onChange={(event) => setForm({ ...form, note: event.target.value })} />
            </Field>
          </div>
          <Button disabled={busy || !/^\d+(\.\d{1,3})?$/.test(form.quantity)} onClick={() => void record()}>
            Save
          </Button>
          <p className={ui.muted}>
            Giving it to stock? Record a treatment on <Link href="/operations/farm/mobs">Mobs</Link>: it comes off here, with its withholding.
          </p>
        </div>
      ) : null}
      {slot.history.length ? (
        <details className={ui.fieldSection}>
          <summary>History</summary>
          <ul className={styles.history}>
            {slot.history.slice(0, 20).map((entry, index) => (
              <li key={index}>
                {formatDate(entry.date)}: {entry.text}, {["treatment", "spray", "disposed", "used", "moved_out"].includes(entry.kind) ? "−" : ""}
                {entry.quantity} {entry.unit}
              </li>
            ))}
          </ul>
          {slot.notCounted.length ? <p className={ui.muted}>{slot.notCounted.length} use{slot.notCounted.length === 1 ? "" : "s"} in another unit weren&apos;t taken off.</p> : null}
        </details>
      ) : null}
      {canManage ? (
        <details className={ui.fieldSection}>
          <summary>Name, kind, reorder level and photo</summary>
          <div className={ui.stack}>
            <div className={ui.inlineForm}>
              <Field label="Product name">
                <input value={settings.name} maxLength={150} onChange={(event) => setSettings({ ...settings, name: event.target.value })} />
              </Field>
              <KindSelect value={settings.kind} onChange={(kind) => setSettings({ ...settings, kind })} />
              <Field label={`Reorder at (${slot.unit ?? "its unit"})`} hint="Shows Running low at or below this.">
                <input inputMode="decimal" value={settings.reorderAt} onChange={(event) => setSettings({ ...settings, reorderAt: event.target.value })} />
              </Field>
            </div>
            <Button variant="secondary" disabled={busy || !settings.name.trim()} onClick={() => void saveSettings()}>
              Save
            </Button>
            <div className={ui.inlineForm}>
              <Field label="Photo of your product" hint="Shown instead of the drawing.">
                <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => void setPhoto(event.target.files?.[0] ?? null)} />
              </Field>
              {slot.photoFileId ? (
                <Button variant="secondary" disabled={busy} onClick={() => void run(() => api(`/api/farming/medicines/${slot.chemicalRecordId}`, { method: "PATCH", body: { organisationId, photoFileId: null } }))}>
                  Use the drawing
                </Button>
              ) : null}
            </div>
            <Button variant="secondary" disabled={busy} onClick={() => void remove()}>
              Take out of the cabinet
            </Button>
            <p className={ui.muted}>Its history and treatments stay, and it stays in the chemical register.</p>
          </div>
        </details>
      ) : null}
    </Card>
  );
}
