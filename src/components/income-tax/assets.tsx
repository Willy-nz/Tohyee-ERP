"use client";

import { InfoTip } from "@/components/info-tip";
import { type FormEvent,Fragment,useState } from "react";
import { DateInput } from "@/components/date-input";
import { Money } from "@/components/books";
import { Badge,Button,Card,Empty,Field,Notice,ui } from "@/components/ui";
import { api,errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { TaxAsset } from "@/lib/tax/income/assets";
import { TAX_DEPRECIATION_METHOD_LABELS,TAX_DEPRECIATION_METHODS,type TaxDepreciationMethod } from "@/lib/tax/income/depreciation";
import { Status,negated } from "@/components/income-tax/shared";

function TaxDetailsForm({ organisationId, asset, onSaved }: { organisationId: string; asset: TaxAsset; onSaved: () => void }) {
  const details = asset.details;
  const [form, setForm] = useState({
    method: (details?.method ?? (asset.bookMethod === "none" ? "not_depreciable" : asset.bookMethod)) as TaxDepreciationMethod,
    rate: details?.rate ?? asset.bookRate ?? "",
    taxCost: details?.taxCost ?? asset.cost,
    businessUsePercent: details?.businessUsePercent ?? "100",
    availableOn: details?.availableOn ?? asset.purchaseDate,
    newAsset: details?.newAsset ?? false,
    investmentBoost: details?.investmentBoost ?? false,
    openingIncomeYear: details?.openingIncomeYear ? String(details.openingIncomeYear) : "",
    openingAtv: details?.openingAtv ?? "",
  });
  const [status, setStatus] = useState<Status>(null);
  const set = <K extends keyof typeof form>(name: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [name]: value }));
  const depreciating = form.method === "dv" || form.method === "sl";
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/api/income-tax/assets/${asset.assetId}`, {
        method: "PUT",
        body: { organisationId, ...form, rate: depreciating ? form.rate : null, investmentBoost: depreciating && form.investmentBoost, version: details?.version ?? 0 },
      });
      setStatus(null);
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <form onSubmit={save}>
      <div className={ui.grid}>
        <Field label="Tax method">
          <select value={form.method} onChange={(event) => set("method", event.target.value as TaxDepreciationMethod)}>
            {TAX_DEPRECIATION_METHODS.map((method) => (
              <option key={method} value={method}>
                {TAX_DEPRECIATION_METHOD_LABELS[method]}
              </option>
            ))}
          </select>
        </Field>
        {depreciating ? (
          <Field label="IRD rate %" hint="From IRD's depreciation rate finder.">
            <input inputMode="decimal" value={form.rate} onChange={(event) => set("rate", event.target.value)} required />
          </Field>
        ) : null}
        <Field label="Tax cost" hint="Excluding GST when registered.">
          <input inputMode="decimal" value={form.taxCost} onChange={(event) => set("taxCost", event.target.value)} />
        </Field>
        <Field label="Business use %">
          <input inputMode="decimal" value={form.businessUsePercent} onChange={(event) => set("businessUsePercent", event.target.value)} />
        </Field>
        <Field label="First available for use">
          <DateInput value={form.availableOn} onChange={(event) => set("availableOn", event.target.value)} />
        </Field>
        <Field label="Tax history from before Tohyee" hint="The income year and its opening adjusted tax value (ATV). Leave blank for an asset bought while using Tohyee.">
          <span>
            <input aria-label="Opening income year" placeholder="Year, e.g. 2026" inputMode="numeric" size={6} value={form.openingIncomeYear} onChange={(event) => set("openingIncomeYear", event.target.value)} />{" "}
            <input aria-label="Opening adjusted tax value" placeholder="ATV" inputMode="decimal" size={10} value={form.openingAtv} onChange={(event) => set("openingAtv", event.target.value)} />
          </span>
        </Field>
      </div>
      {depreciating ? (
        <>
          <div>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={form.newAsset} onChange={(event) => set("newAsset", event.target.checked)} /> New, or new to New Zealand (not second-hand from New Zealand)
            </label>
          </div>
          <div>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={form.investmentBoost} onChange={(event) => set("investmentBoost", event.target.checked)} /> Claim Investment Boost (20% for new assets first available for use on or after 22 May 2025)
            </label>
          </div>
        </>
      ) : null}
      {form.method === "low_value" ? <p className={ui.muted}>Assets bought together from one supplier at the same depreciation rate don&apos;t count as low-value.</p> : null}
      <Button type="submit" size="small">
        Save tax details
      </Button>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </form>
  );
}

export function TaxAssets({ organisationId, assets, incomeYear, onSaved }: { organisationId: string; assets: TaxAsset[]; incomeYear: number; onSaved: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Card
      title="Tax depreciation"
      description={`The tax side of the fixed asset register for the ${incomeYear} income year. Book depreciation keeps posting; for assets with tax details, these figures replace it in taxable income. Type each rate from IRD's rate finder.`}
    >
      {assets.length === 0 ? (
        <Empty>No fixed assets in the register.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Tax method</th>
                <th className={ui.num}>Opening ATV</th>
                <th className={ui.num}>Investment Boost</th>
                <th className={ui.num}>Depreciation</th>
                <th className={ui.num}>Recovered or (loss)</th>
                <th className={ui.num}>Closing ATV</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => {
                const year = asset.year;
                const result = year ? (Number(year.loss) > 0 ? negated(year.loss) : year.recovered) : null;
                return (
                  <Fragment key={asset.assetId}>
                    <tr>
                      <td data-label="Asset">
                        {asset.assetNumber} {asset.name} <span className={ui.muted}>({asset.typeName})</span>
                        {asset.disposal ? <span className={ui.muted}> · sold {formatDate(asset.disposal.date)}</span> : null}
                      </td>
                      <td data-label="Tax method">
                        {asset.details ? (
                          <>
                            {TAX_DEPRECIATION_METHOD_LABELS[asset.details.method]}
                            {asset.details.rate ? ` ${asset.details.rate}%` : ""}
                            {asset.details.businessUsePercent !== "100" ? ` · ${asset.details.businessUsePercent}% business` : ""} {asset.details.investmentBoost ? <Badge tone="green">Investment Boost</Badge> : null}
                          </>
                        ) : (
                          <Badge tone="amber">No tax details: book used</Badge>
                        )}
                      </td>
                      <td data-label="Opening ATV" className={ui.num}>
                        {year ? <Money value={year.openingAtv} /> : null}
                      </td>
                      <td data-label="Investment Boost" className={ui.num}>
                        {year ? <Money value={year.boostClaimed} blankZero /> : null}
                      </td>
                      <td data-label="Depreciation" className={ui.num}>
                        {year ? <Money value={year.depreciationClaimed} blankZero /> : null}
                      </td>
                      <td data-label="Recovered or (loss)" className={ui.num}>
                        {result ? <Money value={result} blankZero /> : null}
                      </td>
                      <td data-label="Closing ATV" className={ui.num}>
                        {year ? <Money value={year.closingAtv} /> : null}
                      </td>
                      <td>
                        <button type="button" className={ui.linkButton} onClick={() => setEditing(editing === asset.assetId ? null : asset.assetId)}>
                          {editing === asset.assetId ? "Close" : asset.details ? "Change" : "Add tax details"}
                        </button>
                      </td>
                    </tr>
                    {editing === asset.assetId ? (
                      <tr>
                        <td colSpan={8}>
                          <TaxDetailsForm
                            key={`${asset.assetId}-${asset.details?.version ?? 0}`}
                            organisationId={organisationId}
                            asset={asset}
                            onSaved={() => {
                              setEditing(null);
                              onSaved();
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className={ui.muted}>
        Depreciation and Investment Boost shown are the business-use share that&apos;s deducted.{" "}
        <InfoTip label="Depreciation">No depreciation is claimed in the year an asset is sold. Where IRD&apos;s pages don&apos;t say (rounding to the cent, the ATV of an asset used partly privately), Tohyee follows its own reading of them.</InfoTip>
      </p>
    </Card>
  );
}
