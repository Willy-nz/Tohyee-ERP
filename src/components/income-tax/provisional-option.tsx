"use client";

import { type FormEvent, useState } from "react";
import { DateInput } from "@/components/date-input";
import { Money } from "@/components/books";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { ProvisionalOptionSetting } from "@/lib/tax/income/provisional-option-store";
import { PROVISIONAL_OPTION_LABELS, PROVISIONAL_OPTIONS, type ProvisionalOption } from "@/lib/tax/income/provisional-options";
import type { Status } from "@/components/income-tax/shared";

/** What each option means, in a sentence (TXF14-TXF17). */
const OPTION_HINTS: Record<ProvisionalOption, string> = {
  standard: "Last year's residual income tax plus 5%, in instalments.",
  estimation: "Your own estimate of this year's residual income tax, which you can change up to the last instalment.",
  ratio: "A percentage of your GST sales every two months. IRD gives you the percentage; choose it with IRD before the year starts.",
  aim: "Worked out by AIM accounting software. Tohyee isn't AIM software, so it shows no instalments or interest for AIM.",
};

/** The provisional tax option for the income year, with IRD's ratio or the estimates (TXF14-TXF17). Choosing here doesn't tell IRD. */
export function ProvisionalOptionCard({ organisationId, setting, onSaved }: { organisationId: string; setting: ProvisionalOptionSetting; onSaved: () => void }) {
  const [option, setOption] = useState<ProvisionalOption>(setting.option);
  const [ratio, setRatio] = useState(setting.ratioPercent ?? "");
  const [status, setStatus] = useState<Status>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/provisional-option", {
        method: "PUT",
        body: { organisationId, incomeYear: setting.incomeYear, option, ratioPercent: option === "ratio" ? ratio : null, version: setting.version },
      });
      setStatus({ tone: "success", text: "Saved." });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <Card title={`Provisional tax option for the ${setting.incomeYear} income year`} description="Choosing an option here doesn't tell IRD: choose it with IRD too.">
      <form onSubmit={save}>
        <div className={ui.grid}>
          <Field label="Option" hint={OPTION_HINTS[option]}>
            <select value={option} onChange={(event) => setOption(event.target.value as ProvisionalOption)}>
              {PROVISIONAL_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {PROVISIONAL_OPTION_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          {option === "ratio" ? (
            <Field label="Ratio from IRD (%)" hint="The percentage in IRD's letter for this year.">
              <input inputMode="decimal" value={ratio} onChange={(event) => setRatio(event.target.value)} />
            </Field>
          ) : null}
        </div>
        <div className={ui.actions}>
          <Button size="small" type="submit" variant="secondary">
            Save option
          </Button>
        </div>
        {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      </form>
      {setting.option === "estimation" ? <Estimates organisationId={organisationId} setting={setting} onSaved={onSaved} /> : null}
    </Card>
  );
}

function Estimates({ organisationId, setting, onSaved }: { organisationId: string; setting: ProvisionalOptionSetting; onSaved: () => void }) {
  const [estimatedOn, setEstimatedOn] = useState("");
  const [amount, setAmount] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("tax-estimate"));
  const [status, setStatus] = useState<Status>(null);
  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/provisional-estimates", { method: "POST", body: { organisationId, idempotencyKey: key, incomeYear: setting.incomeYear, estimatedOn, amount } });
      setEstimatedOn("");
      setAmount("");
      setKey(newIdempotencyKey("tax-estimate"));
      setStatus(null);
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/api/income-tax/provisional-estimates/${id}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <>
      <h3>Estimates given to IRD</h3>
      <p className={ui.muted}>Each estimate counts from the date you gave it to IRD. It must be fair and reasonable; estimate again if it stops being so.</p>
      {setting.estimates.length > 0 ? (
        <ul>
          {setting.estimates.map((estimate) => (
            <li key={estimate.id}>
              {formatDate(estimate.estimatedOn)}: <Money value={estimate.amount} />{" "}
              <Button size="small" variant="secondary" onClick={() => remove(estimate.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={ui.muted}>No estimate yet.</p>
      )}
      <form onSubmit={add}>
        <div className={ui.grid}>
          <Field label="Given to IRD on">
            <DateInput required value={estimatedOn} onChange={(event) => setEstimatedOn(event.target.value)} />
          </Field>
          <Field label="Estimated residual income tax">
            <input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </Field>
        </div>
        <div className={ui.actions}>
          <Button size="small" type="submit" variant="secondary">
            Add estimate
          </Button>
        </div>
        {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      </form>
    </>
  );
}
