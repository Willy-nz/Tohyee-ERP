"use client";

import { useState } from "react";
import { PeoplePicker } from "@/components/chat/people-picker";
import { useConfirm } from "@/components/confirm-dialog";
import { RoomChat } from "@/components/farm-chat";
import { useApiData } from "@/components/hooks";
import { MoreMenu, type MoreMenuItem } from "@/components/more-menu";
import { Button, Field, FormError, Notice, RefreshProblem } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { ChatRoomDetail } from "@/lib/chat/rooms";
import { CHAT_PRIVACY_LINE, MAX_SPACE_NAME } from "@/lib/chat/rules";
import styles from "./chat.module.css";

type Editing = null | "rename" | "add";

/**
 * One of your chats (TCH10-TCH19): its name, its people, the line saying
 * owners and admins can read it, what you can do with it, and its messages.
 */
export function RoomPane({ organisationId, roomId, me, canRemoveAny, onLeft, onChanged }: { organisationId: string; roomId: string; me: string; canRemoveAny: boolean; onLeft: () => void; onChanged: () => void }) {
  const confirm = useConfirm();
  const detail = useApiData<{ room: ChatRoomDetail }>(`/api/chat/rooms/${encodeURIComponent(roomId)}`, { organisationId });
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const room = detail.data?.room;

  async function change(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      setEditing(null);
      setAdding([]);
      detail.reload();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (detail.error && !room) return <Notice tone="error">{detail.error}</Notice>;
  if (!room) return null;

  const base = `/api/chat/rooms/${encodeURIComponent(room.id)}`;
  const items: MoreMenuItem[] = [
    ...(room.canAddPeople ? [{ label: "Add people", onSelect: () => setEditing("add") }] : []),
    ...(room.canManage ? [{ label: "Rename", onSelect: () => { setName(room.name); setEditing("rename"); } }] : []),
    ...(room.canManage
      ? [{
          label: "Close space",
          danger: true,
          onSelect: () =>
            void (async () => {
              if (!(await confirm(`Close ${room.name}? Its messages stay to read, but no one can post in it or add people again.`))) return;
              await change(() => api(base, { method: "PATCH", body: { organisationId, closed: true } }));
            })(),
        }]
      : []),
    ...(room.canLeave
      ? [{
          label: "Leave space",
          danger: true,
          onSelect: () =>
            void (async () => {
              if (!(await confirm(`Leave ${room.name}? You won't see it again unless someone adds you back.`))) return;
              setError(null);
              try {
                await api(`${base}/leave`, { method: "POST", body: { organisationId } });
                onLeft();
              } catch (caught) {
                setError(errorMessage(caught));
              }
            })(),
        }]
      : []),
  ];
  const others = room.members.filter((member) => member.current && member.userId !== me);

  return (
    <div className={styles.main}>
      <div className={styles.roomHead}>
        <h2>{room.name}</h2>
        {items.length ? <MoreMenu items={items} label={`More for ${room.name}`} /> : null}
      </div>
      {room.privacyLine ? <Notice tone="info">{CHAT_PRIVACY_LINE}</Notice> : null}
      {room.closed ? <Notice tone="warning">This space is closed. Its messages are kept to read.</Notice> : null}
      <RefreshProblem problem={detail.refreshError} loadedAt={detail.loadedAt} onRetry={detail.reload} />
      <details className={styles.people}>
        <summary>{room.kind === "everyone" ? `Everyone in Chat (${room.members.length})` : `${room.members.length} people`}</summary>
        <ul>
          {room.members.map((member) => (
            <li key={member.userId}>
              {member.name}
              {member.current ? null : <span className={styles.tag}> (no longer in Chat here)</span>}
            </li>
          ))}
        </ul>
      </details>
      <FormError error={error} />
      {editing === "rename" ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void change(() => api(base, { method: "PATCH", body: { organisationId, name } }));
          }}
        >
          <Field label="Name">
            <input value={name} maxLength={MAX_SPACE_NAME} onChange={(event) => setName(event.target.value)} />
          </Field>
          <div className={styles.formActions}>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Rename"}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {editing === "add" ? (
        <div className={styles.form}>
          <PeoplePicker organisationId={organisationId} chosen={adding} onChange={setAdding} leaveOut={room.members.map((member) => member.userId)} />
          <div className={styles.formActions}>
            <Button disabled={busy || adding.length === 0} onClick={() => void change(() => api(`${base}/members`, { method: "POST", body: { organisationId, userIds: adding } }))}>
              {busy ? "Adding…" : "Add"}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <RoomChat
        key={room.id}
        organisationId={organisationId}
        room={{ kind: "room", roomId: room.id, name: room.name, members: others.map((member) => ({ userId: member.userId, name: member.name })), readOnlyBecause: room.readOnlyBecause }}
        canRemoveAny={canRemoveAny}
        canPost={room.canPost}
      />
    </div>
  );
}
