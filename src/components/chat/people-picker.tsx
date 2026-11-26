"use client";

import { useMemo, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Notice, RefreshProblem } from "@/components/ui";
import styles from "./chat.module.css";

export type PickablePerson = { userId: string; name: string; email: string };

/**
 * Ticks people in Chat (TCH13, TCH15, TCH23): only people who are in Chat
 * now, never yourself, and leaving out anyone already in the chat.
 */
export function PeoplePicker({
  organisationId,
  chosen,
  onChange,
  leaveOut = [],
  max,
}: {
  organisationId: string;
  chosen: string[];
  onChange: (userIds: string[]) => void;
  leaveOut?: readonly string[];
  max?: number;
}) {
  const people = useApiData<{ people: PickablePerson[] }>("/api/chat/people", { organisationId });
  const [search, setSearch] = useState("");
  const shown = useMemo(() => {
    const words = search.trim().toLowerCase();
    return (people.data?.people ?? []).filter(
      (person) => !leaveOut.includes(person.userId) && (!words || person.name.toLowerCase().includes(words) || person.email.toLowerCase().includes(words)),
    );
  }, [people.data, search, leaveOut]);
  const full = max !== undefined && chosen.length >= max;
  return (
    <div className={styles.form}>
      {people.error ? <Notice tone="error">{people.error}</Notice> : null}
      <RefreshProblem problem={people.refreshError} loadedAt={people.loadedAt} onRetry={people.reload} />
      <input type="search" value={search} placeholder="Find someone" aria-label="Find someone" onChange={(event) => setSearch(event.target.value)} />
      <div className={styles.picker} role="group" aria-label="People">
        {people.data && shown.length === 0 ? <p className={styles.tag}>No one else to add.</p> : null}
        {shown.map((person) => {
          const ticked = chosen.includes(person.userId);
          return (
            <label key={person.userId}>
              <input
                type="checkbox"
                checked={ticked}
                disabled={!ticked && full}
                onChange={() => onChange(ticked ? chosen.filter((id) => id !== person.userId) : [...chosen, person.userId])}
              />
              <span>
                {person.name} <span className={styles.tag}>{person.email}</span>
              </span>
            </label>
          );
        })}
      </div>
      {full ? <p className={styles.tag}>That&apos;s as many as a direct message can have. Make a space for a bigger group.</p> : null}
    </div>
  );
}
