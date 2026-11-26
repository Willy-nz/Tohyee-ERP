"use client";

import { useState } from "react";
import { PeoplePicker } from "@/components/chat/people-picker";
import { Button, Field, FormError } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { MAX_DIRECT_PEOPLE, MAX_SPACE_NAME } from "@/lib/chat/rules";
import styles from "./chat.module.css";

/**
 * Starts a direct message (TCH12, TCH13) or makes a space (TCH14). A direct
 * message with people you already have one with opens that one.
 */
export function NewChat({ organisationId, kind, onMade, onCancel }: { organisationId: string; kind: "direct" | "space"; onMade: (roomId: string) => void; onCancel: () => void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestKey] = useState(() => newIdempotencyKey(kind === "direct" ? "chat-direct" : "chat-space"));

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const answer = await api<{ room: { id: string } }>("/api/chat/rooms", {
        method: "POST",
        body: { organisationId, kind, userIds: chosen, ...(kind === "space" ? { name } : {}), idempotencyKey: requestKey },
      });
      onMade(answer.room.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const ready = kind === "direct" ? chosen.length > 0 : name.trim().length > 0;
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void make();
      }}
    >
      <h2>{kind === "direct" ? "New direct message" : "New space"}</h2>
      {kind === "space" ? (
        <Field label="Name">
          <input value={name} maxLength={MAX_SPACE_NAME} placeholder="Stocktake" onChange={(event) => setName(event.target.value)} />
        </Field>
      ) : null}
      <PeoplePicker organisationId={organisationId} chosen={chosen} onChange={setChosen} max={kind === "direct" ? MAX_DIRECT_PEOPLE - 1 : undefined} />
      <FormError error={error} />
      <div className={styles.formActions}>
        <Button type="submit" disabled={!ready || busy}>
          {busy ? "Starting…" : kind === "direct" ? "Start" : "Make space"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
