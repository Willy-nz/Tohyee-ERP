"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { ui } from "@/components/ui";
import { api } from "@/lib/client/api";

/** Whether a report is starred, and a way to star it. */
export function useFavourite(organisationId: string, reportKey: string) {
  const list = useApiData<{ favourites: string[] }>("/api/report-favourites", {
    organisationId,
  });
  const [override, setOverride] = useState<string[] | null>(null);
  const favourites = override ?? list.data?.favourites ?? [];
  const on = favourites.includes(reportKey);
  async function toggle() {
    const result = await api<{ favourites: string[] }>("/api/report-favourites", {
      method: "PUT",
      body: { organisationId, key: reportKey, favourite: !on },
    });
    setOverride(result.favourites);
  }
  return { on, favourites, toggle, loaded: Boolean(list.data) };
}

export function FavouriteButton({ organisationId, reportKey, name }: { organisationId: string; reportKey: string; name: string }) {
  const favourite = useFavourite(organisationId, reportKey);
  return <FavouriteToggle favourite={favourite} name={name} />;
}

/** The star button (aria-pressed), for a favourite state that's shared with a list. */
export function FavouriteToggle({ favourite, name }: { favourite: ReturnType<typeof useFavourite>; name: string }) {
  if (!favourite.loaded) return null;
  return (
    <button
      type="button"
      className={`${ui.button} ${ui.secondary} ${ui.favouriteButton}`}
      aria-pressed={favourite.on}
      aria-label={`Favourite: ${name}`}
      title={favourite.on ? "In your favourites" : "Add to your favourites"}
      onClick={() => void favourite.toggle()}
      data-print="hide"
    >
      <span aria-hidden="true">{favourite.on ? "★" : "☆"}</span>
    </button>
  );
}
