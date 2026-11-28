"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DateInput } from "@/components/date-input";
import { FarmHero, HeroEmpty, HeroTile, HeroTiles } from "@/components/farm-hero";
import { CoverLevelArt } from "@/components/farm-hero-art";
import { useApiData } from "@/components/hooks";
import { Badge, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { type FarmComparison, FRESH_PASTURE_DAYS } from "@/lib/farming/comparison-rules";
import { formatDate, formatQuantity, todayInBrowser } from "@/lib/format";

const int = new Intl.NumberFormat("en-NZ", { maximumFractionDigits: 0 });
const farmLink = (path: string, farmId: string) => `${path}?farm=${encodeURIComponent(farmId)}`;

type Pasture = FarmComparison["farms"][number]["pasture"];

function Cover({ pasture }: { pasture: Pasture }) {
  if (pasture.averageKgDmPerHa === null) return <span className={ui.muted}>No readings</span>;
  return (
    <>
      {int.format(pasture.averageKgDmPerHa)}
      <br />
      <small className={ui.muted}>
        over {pasture.measuredHa} ha{pasture.estimates ? `, ${pasture.estimates} estimated` : ""}
      </small>
    </>
  );
}

function Readings({ pasture }: { pasture: Pasture }) {
  if (!pasture.newestReading) return <Badge tone="amber">None</Badge>;
  return (
    <>
      {formatDate(pasture.newestReading)} {pasture.fresh ? null : <Badge tone="amber">{pasture.daysSinceNewest} days ago</Badge>}
      {pasture.oldestReading && pasture.oldestReading !== pasture.newestReading ? (
        <>
          <br />
          <small className={ui.muted}>oldest used {formatDate(pasture.oldestReading)}</small>
        </>
      ) : null}
    </>
  );
}

function Missing({ pasture }: { pasture: Pasture }) {
  if (!pasture.noReading && !pasture.noArea) return <>None</>;
  return (
    <>
      {pasture.noReading ? `${pasture.noReading} with no reading` : null}
      {pasture.noReading && pasture.noArea ? <br /> : null}
      {pasture.noArea ? `${pasture.noArea} with no area` : null}
    </>
  );
}

/** Every active farm side by side, with all of them together (PF9). */
export function FarmComparisonView({ organisationId }: { organisationId: string }) {
  const [onDate, setOnDate] = useState(todayInBrowser());
  const loaded = useApiData<{ comparison: FarmComparison }>("/api/farming/comparison", { organisationId, onDate });
  const router = useRouter();
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  const data = loaded.data?.comparison;
  const covers = (data?.farms ?? []).map((farm) => (farm.pasture.averageKgDmPerHa === null ? null : Number(farm.pasture.averageKgDmPerHa)));
  const highest = Math.max(0, ...covers.filter((value): value is number => value !== null));
  return (
    <>
    <FarmHero
      eyebrow="All farms / side by side"
      title={data ? `${data.allFarms.farms} ${data.allFarms.farms === 1 ? "farm" : "farms"}` : "All farms"}
      label="All farms compared"
      heading="Pasture cover by farm"
      hint={data?.farms.length ? "Tap a farm for its pasture" : undefined}
      footer="All farms"
      stats={
        data && data.farms.length
          ? [
              { value: int.format(data.allFarms.paddocks), label: "paddocks" },
              { value: data.allFarms.effectiveHa, label: "effective ha" },
              ...(data.allFarms.pasture.averageKgDmPerHa === null ? [] : [{ value: int.format(Number(data.allFarms.pasture.averageKgDmPerHa)), label: "kg DM/ha over all" }]),
              ...(data.allFarms.pasture.farmsNotFresh ? [{ value: data.allFarms.pasture.farmsNotFresh, label: `walked over ${FRESH_PASTURE_DAYS} days ago`, tone: "attention" as const }] : []),
              ...(data.allFarms.farmsWithoutPlan ? [{ value: data.allFarms.farmsWithoutPlan, label: "with no fertiliser plan", tone: "attention" as const }] : []),
            ]
          : []
      }
    >
      {!data ? <HeroEmpty>Loading…</HeroEmpty> : null}
      {data && !data.farms.length ? <HeroEmpty>No farms yet.</HeroEmpty> : null}
      {data?.farms.length ? (
        <HeroTiles>
          {data.farms.map((farm, index) => (
            <HeroTile
              key={farm.farmId}
              title={farm.farmName}
              figure={covers[index] === null ? "–" : int.format(covers[index]!)}
              unit={covers[index] === null ? undefined : "kg DM/ha"}
              picture={<CoverLevelArt cover={covers[index]} highest={highest} />}
              lines={[
                `${farm.effectiveHa} ha, ${farm.paddocks} paddock${farm.paddocks === 1 ? "" : "s"}`,
                farm.pasture.newestReading ? `Walked ${formatDate(farm.pasture.newestReading)}` : "No readings",
                farm.pasture.noReading ? `${farm.pasture.noReading} with no reading` : "",
              ].filter(Boolean)}
              tone={farm.pasture.newestReading && !farm.pasture.fresh ? "attention" : undefined}
              onOpen={() => router.push(farmLink("/operations/farming/pasture", farm.farmId))}
            />
          ))}
        </HeroTiles>
      ) : null}
    </FarmHero>
    <Card
      title="All farms"
      description={`Pasture cover uses each paddock's latest reading on or before the date, weighted by area. The all-farms figure is worked from every paddock, not by averaging the farms. A farm walk more than ${FRESH_PASTURE_DAYS} days old is flagged. Fertiliser is each farm's latest plan.`}
    >
      <div className={ui.inlineForm}>
        <Field label="On">
          <DateInput value={onDate} onChange={(event) => setOnDate(event.target.value || todayInBrowser())} />
        </Field>
      </div>
      {!data ? <p className={ui.muted}>Loading…</p> : null}
      {data && data.farms.length === 0 ? (
        <Empty>
          No farms yet. Add one under <Link href="/operations/farming">Farms and paddocks</Link>.
        </Empty>
      ) : null}
      {data && data.farms.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Farm</th>
                <th className={ui.num}>Paddocks</th>
                <th className={ui.num}>Effective ha</th>
                <th className={ui.num}>Mapped ha</th>
                <th className={ui.num}>Cover (kg DM/ha)</th>
                <th>Latest reading</th>
                <th>Paddocks missing</th>
                <th>Fertiliser plan</th>
              </tr>
            </thead>
            <tbody>
              {data.farms.map((farm) => (
                <tr key={farm.farmId}>
                  <td data-label="Farm" style={{ minWidth: "9rem" }}>
                    <Link href={farmLink("/operations/farming", farm.farmId)}>
                      <strong>{farm.farmName}</strong>
                    </Link>
                    <br />
                    <small>
                      <Link href={farmLink("/operations/farming/soil", farm.farmId)}>Soil</Link> · <Link href={farmLink("/operations/farming/pasture", farm.farmId)}>Pasture</Link>
                    </small>
                  </td>
                  <td data-label="Paddocks" className={ui.num}>{farm.paddocks}</td>
                  <td data-label="Effective ha" className={ui.num}>{farm.effectiveHa}</td>
                  <td data-label="Mapped ha" className={ui.num}>{farm.mappedHa}</td>
                  <td data-label="Cover (kg DM/ha)" className={ui.num}>
                    <Link href={farmLink("/operations/farming/pasture", farm.farmId)}>
                      <Cover pasture={farm.pasture} />
                    </Link>
                  </td>
                  <td data-label="Latest reading"><Readings pasture={farm.pasture} /></td>
                  <td data-label="Paddocks missing"><Missing pasture={farm.pasture} /></td>
                  <td data-label="Fertiliser plan">
                    {farm.plan ? (
                      <>
                        <Link href={`/operations/farming/fertiliser?plan=${encodeURIComponent(farm.plan.planId)}`}>{farm.plan.planName}</Link>
                        <br />
                        <small className={ui.muted}>
                          {formatQuantity(farm.plan.appliedTonnes)} t applied of {farm.plan.plannedTonnes === null ? "no plan lines yet" : `${formatQuantity(farm.plan.plannedTonnes)} t planned`}
                          <br />
                          {farm.plan.applications} {farm.plan.applications === 1 ? "application" : "applications"}
                          {farm.plan.lastAppliedOn ? `, last ${formatDate(farm.plan.lastAppliedOn)}` : ""}
                        </small>
                      </>
                    ) : (
                      <Link href={farmLink("/operations/farming/fertiliser", farm.farmId)}>No plan</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td data-label="Farm">
                  <strong>All {data.allFarms.farms} farms</strong>
                </td>
                <td data-label="Paddocks" className={ui.num}><strong>{data.allFarms.paddocks}</strong></td>
                <td data-label="Effective ha" className={ui.num}><strong>{data.allFarms.effectiveHa}</strong></td>
                <td data-label="Mapped ha" className={ui.num}><strong>{data.allFarms.mappedHa}</strong></td>
                <td data-label="Cover (kg DM/ha)" className={ui.num}>
                  <strong><Cover pasture={data.allFarms.pasture} /></strong>
                </td>
                <td data-label="Latest reading">
                  <Readings pasture={data.allFarms.pasture} />
                  {data.allFarms.pasture.farmsNotFresh ? (
                    <>
                      <br />
                      <small className={ui.muted}>
                        {data.allFarms.pasture.farmsNotFresh} of {data.allFarms.farms} farms not walked in the last {FRESH_PASTURE_DAYS} days
                      </small>
                    </>
                  ) : null}
                </td>
                <td data-label="Paddocks missing"><Missing pasture={data.allFarms.pasture} /></td>
                <td data-label="Fertiliser plan">
                  <strong>{data.allFarms.farmsWithoutPlan ? `${data.allFarms.farmsWithoutPlan} without a plan` : "Every farm has one"}</strong>
                  <br />
                  <small className={ui.muted}>
                    {formatQuantity(data.allFarms.appliedTonnes)} t applied of {formatQuantity(data.allFarms.plannedTonnes)} t planned
                  </small>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
      {data ? <p className={ui.muted}>Figures are on {formatDate(data.onDate)}. Archived farms aren&apos;t included. Money isn&apos;t shown here: farm-level income and costs need the farm reporting rules first.</p> : null}
    </Card>
    </>
  );
}
