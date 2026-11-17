"use client";

import { InfoTip } from "@/components/info-tip";
import { DateInput } from "@/components/date-input";
import { type FormEvent,useState } from "react";
import { Money } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { LivestockSuggestions } from "@/components/livestock-suggestions";
import { Badge,Button,Card,Empty,Field,Notice,Stat,ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api,errorMessage,newIdempotencyKey } from "@/lib/client/api";
import { formatDate,formatMoney,todayInBrowser } from "@/lib/format";
import { dec } from "@/lib/money/decimal";
import { rationsAdjustmentPosting } from "@/lib/livestock/rations-rules";
import type { RationsYear } from "@/lib/livestock/rations-adjustments";
import { classesOf,KIND_NAMES,LIVESTOCK_KINDS,type LivestockKind } from "@/lib/livestock/classes";
import type { LivestockLocation,LivestockSettings,Movement,MovementType } from "@/lib/livestock/movements";
import { MOVEMENT_LABELS,MOVEMENT_ORDER,NotOn,Steps,YearPicker,defaultYear,useLivestockSettings,yearEnds } from "@/components/livestock/shared";

// Movements ------------------------------------------------------------------------

export function LivestockMovements({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const settings = useLivestockSettings(organisationId);
  const movements = useApiData<{ movements: Movement[] }>("/api/livestock/movements", { organisationId, includeVoided: "true" });
  const locations = useApiData<{ locations: LivestockLocation[] }>("/api/livestock/locations", { organisationId });
  const [form, setForm] = useState({
    movementType: "birth" as MovementType,
    movementDate: todayInBrowser(),
    kind: "dairy_cattle" as LivestockKind,
    classCode: "r1_heifers",
    toClassCode: "",
    head: "",
    amount: "",
    heldFor: "",
    rationsFor: "owner" as "owner" | "staff",
    bobbyCalves: false,
    boundToHerdScheme: false,
    locationId: "",
    toLocationId: "",
    note: "",
  });
  const [key, setKey] = useState(() => newIdempotencyKey("lv"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (settings.error) return <Notice tone="error">{settings.error}</Notice>;
  if (!settings.data) return <p className={ui.muted}>Loading…</p>;
  if (!settings.data.settings.enabled) return <NotOn canSetUp={can("admin")} />;
  const classes = classesOf(form.kind);
  // Bobby calves (LV29): a purchase of beef or dairy cattle into a rising one-year class.
  // Or a sale of dairy calves as bobby calves, which IRD's NSC formula leaves out (LV32).
  const canBeBobbies =
    ((form.movementType === "purchase" && (form.kind === "dairy_cattle" || form.kind === "beef_cattle")) || (form.movementType === "sale" && form.kind === "dairy_cattle")) &&
    classes.find((entry) => entry.code === form.classCode)?.nsc === "rising_1";
  const activeLocations = (locations.data?.locations ?? []).filter((location) => !location.archived);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        organisationId,
        source: "ui",
        idempotencyKey: key,
        movementType: form.movementType,
        movementDate: form.movementDate,
        kind: form.kind,
        classCode: form.classCode,
        head: form.head,
        note: form.note || null,
        locationId: form.locationId || null,
      };
      if (form.movementType === "reclass") body.toClassCode = form.toClassCode;
      if (form.movementType === "transfer") body.toLocationId = form.toLocationId;
      if (form.movementType === "purchase" || form.movementType === "sale") body.amount = form.amount || null;
      if (canBeBobbies && form.bobbyCalves) body.bobbyCalves = true;
      if (form.movementType === "purchase" && form.boundToHerdScheme) body.boundToHerdScheme = true;
      if (form.movementType === "arrival" || form.movementType === "departure") body.heldFor = form.heldFor;
      if (form.movementType === "rations") {
        body.rationsFor = form.rationsFor;
      }
      await api("/api/livestock/movements", { method: "POST", body });
      setMessage(`Recorded: ${MOVEMENT_LABELS[form.movementType].toLowerCase()}, ${form.head} ${classes.find((entry) => entry.code === form.classCode)?.name.toLowerCase()}.`);
      setKey(newIdempotencyKey("lv"));
      setForm({ ...form, head: "", amount: "", note: "", bobbyCalves: false, boundToHerdScheme: false });
      movements.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function voidOne(movement: Movement) {
    const ok = await confirm(`Void this movement (${MOVEMENT_LABELS[movement.movementType].toLowerCase()}, ${movement.head} ${movement.className.toLowerCase()} on ${formatDate(movement.movementDate)})?`, {
      confirmLabel: "Void",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/livestock/movements/${movement.id}/void`, { method: "POST", body: { organisationId, reason: "Voided in Livestock › Movements" } });
      movements.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <>
      <Steps current="movements" />
      <LivestockSuggestions organisationId={organisationId} onAccepted={movements.reload} />
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {can("bookkeeper") ? (
        <Card title="Record a movement" description={<>Births go into the rising one-year classes. Nothing posts.{" "}<InfoTip label="Movements">Classes are what each animal will be at balance date. Nothing posts: values come from the year-end valuation, and homekill from the accountant&apos;s yearly adjustment below.</InfoTip></>}>
          <div className={ui.grid}>
            <Field label="What happened">
              <select value={form.movementType} onChange={(event) => setForm({ ...form, movementType: event.target.value as MovementType })}>
                {MOVEMENT_ORDER.map((type) => (
                  <option key={type} value={type}>
                    {MOVEMENT_LABELS[type]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Date">
              <DateInput value={form.movementDate} onChange={(event) => setForm({ ...form, movementDate: event.target.value })} />
            </Field>
            <Field label="Livestock">
              <select
                value={form.kind}
                onChange={(event) => {
                  const kind = event.target.value as LivestockKind;
                  setForm({ ...form, kind, classCode: classesOf(kind)[0].code, toClassCode: "" });
                }}
              >
                {LIVESTOCK_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_NAMES[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={form.movementType === "reclass" ? "From class" : "Class"}>
              <select value={form.classCode} onChange={(event) => setForm({ ...form, classCode: event.target.value })}>
                {classes
                  .filter((entry) => form.movementType !== "birth" || entry.birth)
                  .map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {entry.name}
                    </option>
                  ))}
              </select>
            </Field>
            {form.movementType === "reclass" ? (
              <Field label="To class">
                <select value={form.toClassCode} onChange={(event) => setForm({ ...form, toClassCode: event.target.value })}>
                  <option value="">Choose…</option>
                  {classes
                    .filter((entry) => entry.code !== form.classCode)
                    .map((entry) => (
                      <option key={entry.code} value={entry.code}>
                        {entry.name}
                      </option>
                    ))}
                </select>
              </Field>
            ) : null}
            <Field label="Head">
              <input inputMode="numeric" value={form.head} onChange={(event) => setForm({ ...form, head: event.target.value })} />
            </Field>
            {form.movementType === "purchase" || form.movementType === "sale" ? (
              <Field label="Amount excl. GST" hint="Needed for the trading statement, unless the invoice or bill line is linked.">
                <input inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
              </Field>
            ) : null}
            {canBeBobbies ? (
              <label className={ui.checkbox}>
                <input type="checkbox" checked={form.bobbyCalves} onChange={(event) => setForm({ ...form, bobbyCalves: event.target.checked })} /> Bobby calves
                <InfoTip label="Bobby calves">Bought: dairy-bred calves bought for rearing before they were weaned off milk, and not with their mothers. Under national standard cost they carry IRD&apos;s cost for purchased bobby calves as well as what they cost. Sold: dairy calves sold young as bobby calves, which IRD&apos;s cost formula leaves out.</InfoTip>
              </label>
            ) : null}
            {form.movementType === "purchase" ? (
              <label className={ui.checkbox}>
                <input type="checkbox" checked={form.boundToHerdScheme} onChange={(event) => setForm({ ...form, boundToHerdScheme: event.target.checked })} /> From an associated person who used the herd scheme
                <InfoTip label="Associated person">
                  Bought from someone associated with the farm (family, a related company or trust) who valued them under the herd scheme, not in the ordinary course of business. The farm must keep them in the herd scheme. IRD has exceptions, such as some transfers between generations and from a deceased estate (OS 25/02 paras 54-58): leave this off if one applies.
                </InfoTip>
              </label>
            ) : null}
            {form.movementType === "rations" ? (
              <Field label="Whose rations">
                <select value={form.rationsFor} onChange={(event) => setForm({ ...form, rationsFor: event.target.value as "owner" | "staff" })}>
                  <option value="owner">The owner&apos;s household</option>
                  <option value="staff">Staff</option>
                </select>
              </Field>
            ) : null}
            {form.movementType === "rations" && form.rationsFor === "owner" ? (
              <p className={ui.muted}>Just the head count. Nothing is posted: the accountant enters one homekill adjustment for the year, below.</p>
            ) : null}
            {form.movementType === "rations" && form.rationsFor === "staff" ? (
              <p className={ui.muted}>Nothing is posted for staff rations: the lower closing stock is the cost.</p>
            ) : null}
            {form.movementType === "arrival" || form.movementType === "departure" ? (
              <Field label="Whose stock">
                <input value={form.heldFor} onChange={(event) => setForm({ ...form, heldFor: event.target.value })} />
              </Field>
            ) : null}
            {activeLocations.length > 0 ? (
              <Field label={form.movementType === "transfer" ? "From location" : "Location"}>
                <select value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })}>
                  <option value="">No location</option>
                  {activeLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {form.movementType === "transfer" ? (
              <Field label="To location" hint={activeLocations.length === 0 ? "Add locations in Livestock settings first." : undefined}>
                <select value={form.toLocationId} onChange={(event) => setForm({ ...form, toLocationId: event.target.value })}>
                  <option value="">Choose…</option>
                  {activeLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label="Note">
              <input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
            </Field>
          </div>
          <Button disabled={busy || form.head.trim() === ""} onClick={() => void save()}>
            Record
          </Button>
        </Card>
      ) : null}

      <Card title="Movements">
        {movements.error ? <Notice tone="error">{movements.error}</Notice> : null}
        {movements.data && movements.data.movements.length === 0 ? <Empty>No movements yet.</Empty> : null}
        {movements.data && movements.data.movements.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  <th>Class</th>
                  <th className={ui.num}>Head</th>
                  <th className={ui.num}>Amount</th>
                  <th>Details</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {movements.data.movements.map((movement) => (
                  <tr key={movement.id}>
                    <td data-label="Date">{formatDate(movement.movementDate)}</td>
                    <td data-label="What">
                      {MOVEMENT_LABELS[movement.movementType]} {movement.voided ? <Badge tone="red">Voided</Badge> : null}
                    </td>
                    <td data-label="Class">
                      {KIND_NAMES[movement.kind]}: {movement.className}
                      {movement.toClassCode ? ` → ${classesOf(movement.kind).find((entry) => entry.code === movement.toClassCode)?.name ?? movement.toClassCode}` : ""}
                    </td>
                    <td data-label="Head" className={ui.num}>
                      {movement.head}
                    </td>
                    <td data-label="Amount" className={ui.num}>
                      {movement.amount ? <Money value={movement.amount} /> : null}
                    </td>
                    <td data-label="Details">
                      {[
                        movement.heldFor ? `For ${movement.heldFor}` : null,
                        movement.bobbyCalves ? "Bobby calves" : null,
                        movement.boundToHerdScheme ? "From an associated person (herd scheme)" : null,
                        movement.rationsFor ? (movement.rationsFor === "owner" ? (movement.journalId ? "Owner's rations, posted at market value (before yearly adjustments)" : "Owner's rations (homekill)") : "Staff rations") : null,
                        movement.locationName,
                        movement.toLocationName ? `to ${movement.toLocationName}` : null,
                        movement.invoiceNumber ? `Invoice ${movement.invoiceNumber}` : null,
                        movement.billReference ? `Bill ${movement.billReference}` : null,
                        movement.note,
                        movement.voidReason ? `Voided: ${movement.voidReason}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </td>
                    <td>
                      {can("bookkeeper") && !movement.voided ? (
                        <Button variant="secondary" size="small" onClick={() => void voidOne(movement)}>
                          Void
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {can("bookkeeper") ? <HomekillYear organisationId={organisationId} settings={settings.data.settings} onChanged={movements.reload} /> : null}
    </>
  );
}

/**
 * The owner's rations (homekill) as one adjustment a year (RAT5-RAT10). The head count is for information; the amount is the
 * accountant's.
 */
function HomekillYear({ organisationId, settings, onChanged }: { organisationId: string; settings: LivestockSettings; onChanged: () => void }) {
  const years = yearEnds(settings);
  const [yearEnd, setYearEnd] = useState(() => defaultYear(years));
  const loaded = useApiData<{ year: RationsYear }>(yearEnd ? "/api/livestock/rations-adjustments" : null, { organisationId, yearEnd });
  const [form, setForm] = useState({ adjustmentDate: "", amount: "", reason: "", gstApplies: false, amountIncludesGst: false });
  const [voidReason, setVoidReason] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("hk"));
  const [error, setError] = useState<string | null>(null);
  const year = loaded.data?.year;
  const preview =
    form.gstApplies && /^\d+(\.\d{1,2})?$/.test(form.amount.trim()) ? rationsAdjustmentPosting({ amount: dec(form.amount.trim()), gstApplies: true, includesGst: form.amountIncludesGst }) : null;
  const done = () => {
    setError(null);
    setKey(newIdempotencyKey("hk"));
    setForm({ adjustmentDate: "", amount: "", reason: "", gstApplies: false, amountIncludesGst: false });
    setVoidReason("");
    loaded.reload();
    onChanged();
  };
  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/livestock/rations-adjustments", {
        method: "POST",
        body: {
          organisationId,
          idempotencyKey: key,
          yearEnd,
          adjustmentDate: form.adjustmentDate || null,
          amount: form.amount,
          reason: form.reason,
          gstApplies: form.gstApplies,
          amountIncludesGst: form.gstApplies ? form.amountIncludesGst : null,
        },
      });
      done();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  async function voidIt(event: FormEvent, id: string) {
    event.preventDefault();
    try {
      await api(`/api/livestock/rations-adjustments/${id}/void`, { method: "POST", body: { organisationId, reason: voidReason } });
      done();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <Card
      title="Homekill for the year (owner's rations)"
      description="One adjustment a year, the amount the accountant chooses: Dr owner drawings or current account, Cr rations income, and Cr GST if it applies. The head count is for information."
    >
      <YearPicker years={years} value={yearEnd} onChange={setYearEnd} />
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {year ? (
        <>
          <div className={ui.grid}>
            <Stat label="Killed for the owner this year" value={`${year.ownerHead} head`} />
            <Stat label="Killed for staff (not valued)" value={`${year.staffHead} head`} />
          </div>
          {year.postedPerEvent !== "0.00" ? (
            <Notice tone="warning">
              {formatMoney(year.postedPerEvent)} of rations income was already posted this year, one animal at a time, before yearly adjustments. It stays posted; leave it out of the adjustment so
              it isn&apos;t counted twice.
            </Notice>
          ) : null}
          {year.current ? (
            <>
              <p>
                <strong>
                  <Money value={year.current.amount} />
                </strong>{" "}
                on {formatDate(year.current.adjustmentDate)}
                {year.current.gstApplies ? ` · GST ${formatMoney(year.current.gstAmount)} (${year.current.amountIncludesGst ? "included in the amount" : "on top of the amount"})` : " · No GST"} · {year.current.reason}
              </p>
              <form className={ui.inlineForm} onSubmit={(event) => void voidIt(event, year.current!.id)}>
                <Field label="Reason for voiding" hint="Its journal is reversed on its own date. Then enter the new amount.">
                  <input value={voidReason} maxLength={500} onChange={(event) => setVoidReason(event.target.value)} required />
                </Field>
                <Button type="submit" variant="secondary">
                  Void adjustment
                </Button>
              </form>
            </>
          ) : (
            <form className={ui.inlineForm} onSubmit={(event) => void add(event)}>
              <Field label="Amount">
                <input inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} required />
              </Field>
              <Field label="Date" hint={`Leave blank for the balance date, ${formatDate(yearEnd)}.`}>
                <DateInput value={form.adjustmentDate} onChange={(event) => setForm({ ...form, adjustmentDate: event.target.value })} />
              </Field>
              <Field label="Basis" hint="Why this amount, for example how it was worked out.">
                <input value={form.reason} maxLength={500} onChange={(event) => setForm({ ...form, reason: event.target.value })} required />
              </Field>
              {year.gstRegistered ? (
                <>
                  <label className={ui.checkbox}>
                    <input type="checkbox" checked={form.gstApplies} onChange={(event) => setForm({ ...form, gstApplies: event.target.checked })} /> GST applies
                  </label>
                  {form.gstApplies ? (
                    <label className={ui.checkbox}>
                      <input type="checkbox" checked={form.amountIncludesGst} onChange={(event) => setForm({ ...form, amountIncludesGst: event.target.checked })} /> The amount includes GST
                    </label>
                  ) : null}
                </>
              ) : (
                <p className={ui.muted}>Not GST-registered at the balance date, so no GST.</p>
              )}
              {preview ? (
                <p className={ui.muted}>
                  Posts Dr {formatMoney(preview.drawings)}, Cr rations income {formatMoney(preview.income)}, Cr GST {formatMoney(preview.gst)}; in the GST return for its date.
                </p>
              ) : null}
              <Button type="submit">Post adjustment</Button>
            </form>
          )}
          {year.voided.length > 0 ? (
            <details>
              <summary>Voided ({year.voided.length})</summary>
              <ul>
                {year.voided.map((entry) => (
                  <li key={entry.id} className={ui.muted}>
                    {formatMoney(entry.amount)} on {formatDate(entry.adjustmentDate)}: voided, {entry.voided?.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Card>
  );
}
