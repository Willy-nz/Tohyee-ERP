"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { readFileAsBase64 } from "@/components/bank/common";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Button, Notice, RefreshProblem } from "@/components/ui";
import { compressPhoto } from "@/lib/offline/photos";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { ChatLink, ChatLinkKind, ChatMessage } from "@/lib/farming/chat";
import type { Farm, Paddock } from "@/lib/farming/paddocks";
import { useVoiceRecorder, voiceLength } from "@/components/voice-recorder";
import { MentionPicker, type MentionPerson, mentionsStillIn } from "@/components/chat/mention-picker";
import styles from "./farm-chat.module.css";

/** How often an open chat checks for new messages. */
const POLL_MS = 15_000;

/** A farm's message, or a Chat room's (TCH1, TCH10), which has no farm or links. */
export type Named = Omit<ChatMessage, "farmId" | "links"> & { farmId?: string; links?: ChatLink[]; mentions?: string[]; postedByName?: string; removedByName?: string };

/** Which chat: a farm's (FCH1), or one of Chat's rooms: Everyone, a space or a direct message (TCH10). */
export type ChatRoomKind =
  | { kind: "farm"; farm: Pick<Farm, "id" | "name"> }
  | { kind: "room"; roomId: string; name: string; members: MentionPerson[]; readOnlyBecause: string | null };

/** Where a chat's messages, read marker, take-down and files are. */
function chatApi(room: ChatRoomKind): { list: string; read: string; remove: (id: string) => string; files: string } {
  if (room.kind === "farm") return { list: "/api/farming/chat", read: "/api/farming/chat/read", remove: (id) => `/api/farming/chat/${id}`, files: "/api/farming/chat" };
  const base = `/api/chat/rooms/${encodeURIComponent(room.roomId)}`;
  return { list: `${base}/messages`, read: `${base}/read`, remove: (id) => `/api/chat/${id}`, files: "/api/chat" };
}
type LinkChoice = { kind: ChatLinkKind; id: string; label: string };

/** Where a chip goes: the paddock's or mob's timeline, or the farm's tasks. */
export function chatLinkHref(farmId: string, link: LinkChoice | ChatLink): string {
  if (link.kind === "task") return `/operations/farming/tasks?farm=${encodeURIComponent(farmId)}`;
  return `/operations/farm/timeline?farm=${encodeURIComponent(farmId)}&${link.kind}=${encodeURIComponent(link.id)}`;
}

function when(at: string): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** One message, as the chat and a paddock's or mob's page show it. */
export function ChatBubble({ message, organisationId, onRemove, api: base = "/api/farming/chat" }: { message: Named; organisationId: string; onRemove?: (message: Named) => void; api?: string }) {
  return (
    <li className={`${styles.message} ${message.mine ? styles.mine : ""}`}>
      <div className={styles.meta}>
        <strong>{message.postedByName ?? message.postedByEmail}</strong>
        {message.viaAi ? <span className={styles.ai}>via their AI</span> : null}
        <span>{when(message.createdAt)}</span>
      </div>
      {message.removed ? (
        <p className={styles.removed}>Taken down by {message.removedByName ?? message.removedByEmail}.</p>
      ) : (
        <>
          {message.body ? <p className={styles.body}>{message.body}</p> : null}
          {message.attachments.some((file) => file.kind === "photo") ? (
            <div className={styles.photos}>
              {message.attachments
                .filter((file) => file.kind === "photo")
                .map((file) => {
                  const src = `${base}/attachments/${file.id}?organisationId=${encodeURIComponent(organisationId)}`;
                  return (
                    <a key={file.id} href={src} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element -- a private photo from Tohyee's own API */}
                      <img src={src} alt={file.fileName} loading="lazy" />
                    </a>
                  );
                })}
            </div>
          ) : null}
          {message.attachments
            .filter((file) => file.kind === "voice")
            .map((file) => (
              <div key={file.id} className={styles.voice}>
                <audio controls preload="none" src={`${base}/attachments/${file.id}?organisationId=${encodeURIComponent(organisationId)}`} aria-label="Voice note" />
                {file.seconds ? <span>{voiceLength(file.seconds)}</span> : null}
              </div>
            ))}
          {message.links?.length ? (
            <div className={styles.chips}>
              {message.links.map((link) => (
                <Link key={`${link.kind}-${link.id}`} className={styles.chip} href={chatLinkHref(message.farmId ?? "", link)}>
                  {link.kind === "paddock" ? "Paddock" : link.kind === "mob" ? "Mob" : "Task"}: {link.label}
                </Link>
              ))}
            </div>
          ) : null}
          {onRemove ? (
            <button type="button" className={styles.remove} onClick={() => onRemove(message)}>
              Take down
            </button>
          ) : null}
        </>
      )}
    </li>
  );
}

/**
 * A farm's chat (FCH1-FCH6): everyone who can see the farm. Messages with
 * photos and what they're about; new ones arrive every 15 seconds while
 * it's open, and reading it clears the unread count.
 */
export function FarmChat({ organisationId, farm, canRemoveAny, canPost = true, inChatApp = false }: { organisationId: string; farm: Pick<Farm, "id" | "name">; canRemoveAny: boolean; canPost?: boolean; inChatApp?: boolean }) {
  return <ChatRoom organisationId={organisationId} room={{ kind: "farm", farm }} canRemoveAny={canRemoveAny} canPost={canPost} inChatApp={inChatApp} />;
}

/** One of Chat's rooms (TCH10-TCH18): words, photos, voice notes and mentions, no links. */
export function RoomChat({ organisationId, room, canRemoveAny, canPost }: { organisationId: string; room: Extract<ChatRoomKind, { kind: "room" }>; canRemoveAny: boolean; canPost: boolean }) {
  return <ChatRoom organisationId={organisationId} room={room} canRemoveAny={canRemoveAny} canPost={canPost} inChatApp />;
}

function ChatRoom({ organisationId, room, canRemoveAny, canPost, inChatApp }: { organisationId: string; room: ChatRoomKind; canRemoveAny: boolean; canPost: boolean; inChatApp: boolean }) {
  const confirm = useConfirm();
  const endpoints = chatApi(room);
  const base = endpoints.list;
  const farm = room.kind === "farm" ? room.farm : null;
  const members = room.kind === "room" ? room.members : null;
  const scope: Record<string, string> = farm ? { farmId: farm.id } : {};
  const roomName = farm ? farm.name : room.kind === "room" ? room.name : "";
  const farmKey = farm?.id ?? (room.kind === "room" ? room.roomId : "");
  const chat = useApiData<{ messages: Named[]; more: boolean }>(base, { organisationId, ...scope });
  const paddocks = useApiData<{ paddocks: Paddock[] }>(farm ? `/api/farming/farms/${farm.id}/paddocks` : null, { organisationId });
  const mobs = useApiData<{ mobs: Array<{ id: string; name: string }> }>(farm ? `/api/farming/farms/${farm.id}/mobs` : null, { organisationId });
  const tasks = useApiData<{ tasks: Array<{ id: string; title: string }> }>(farm ? `/api/farming/farms/${farm.id}/tasks` : null, { organisationId });
  const [older, setOlder] = useState<Named[]>([]);
  const [olderMore, setOlderMore] = useState<boolean | null>(null);
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [links, setLinks] = useState<LinkChoice[]>([]);
  const [mentioned, setMentioned] = useState<MentionPerson[]>([]);
  const [caret, setCaret] = useState(0);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const voice = useVoiceRecorder();
  const [error, setError] = useState<string | null>(null);
  // One key per message until it's sent, so a retry after a lost reply doesn't post it twice.
  const [sendKey, setSendKey] = useState(() => newIdempotencyKey(farm ? "farm-chat" : "chat"));
  const endRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLFormElement>(null);

  // On a phone the compose box floats over the list, so the list keeps that much room at the bottom.
  useEffect(() => {
    const form = composeRef.current;
    const box = chatRef.current;
    if (!form || !box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => box.style.setProperty("--compose-height", `${Math.ceil(form.getBoundingClientRect().height)}px`));
    observer.observe(form);
    return () => observer.disconnect();
  }, []);
  const reload = chat.reload;

  useEffect(() => {
    const timer = window.setInterval(() => reload(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const messages = useMemo(() => [...older, ...(chat.data?.messages ?? [])], [older, chat.data]);
  const latest = chat.data?.messages.at(-1)?.id ?? null;

  // Reading the newest message clears the farm's unread count, and the view keeps to the bottom.
  useEffect(() => {
    if (!latest) return;
    endRef.current?.scrollIntoView({ block: "end" });
    void api(endpoints.read, { method: "POST", body: { organisationId, ...scope, upTo: latest } }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope and endpoints follow the chat, already in farmKey
  }, [latest, organisationId, base, farmKey]);

  const choices: LinkChoice[] = [
    ...(paddocks.data?.paddocks ?? []).map((entry) => ({ kind: "paddock" as const, id: entry.id, label: entry.name })),
    ...(mobs.data?.mobs ?? []).map((entry) => ({ kind: "mob" as const, id: entry.id, label: entry.name })),
    ...(tasks.data?.tasks ?? []).map((entry) => ({ kind: "task" as const, id: entry.id, label: entry.title })),
  ];

  async function loadOlder() {
    const first = messages[0]?.id;
    if (!first) return;
    setError(null);
    try {
      const answer = await api<{ messages: Named[]; more: boolean }>(
        `${base}?${new URLSearchParams({ organisationId, ...scope, before: first }).toString()}`,
      );
      setOlder((current) => [...answer.messages, ...current]);
      setOlderMore(answer.more);
    } catch (caught) {
      setError(`Couldn't load older messages. ${errorMessage(caught)}`);
    }
  }

  async function send() {
    if (voice.recording || (!body.trim() && photos.length === 0 && !voice.note)) return;
    setBusy(true);
    setError(null);
    try {
      // A smaller JPEG copy of each photo: full-size phone photos are slow on a farm's mobile signal.
      const encoded = await Promise.all(photos.map(async (file) => {
        const copy = await compressPhoto(file);
        const fileName = copy === file ? file.name : `${file.name.replace(/\.[^.]*$/, "") || "photo"}.jpg`;
        return { fileName, contentBase64: await readFileAsBase64(copy === file ? file : new File([copy], fileName, { type: "image/jpeg" })) };
      }));
      const recorded = voice.note ? { seconds: voice.note.seconds, contentBase64: await readFileAsBase64(voice.note.file) } : undefined;
      await api(base, {
        method: "POST",
        body: {
          organisationId,
          ...scope,
          body,
          photos: encoded,
          voice: recorded,
          ...(farm ? { links: links.map(({ kind, id }) => ({ kind, id })) } : {}),
          ...(members ? { mentions: mentionsStillIn(body, mentioned).map((person) => person.userId) } : {}),
          idempotencyKey: sendKey,
        },
      });
      setSendKey(newIdempotencyKey(farm ? "farm-chat" : "chat"));
      setBody("");
      setPhotos([]);
      setLinks([]);
      setMentioned([]);
      voice.clear();
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(message: Named) {
    if (!(await confirm("Take this message down? Its words, photos and voice note go for everyone; a note that it was taken down stays."))) return;
    try {
      await api(`${endpoints.remove(message.id)}?organisationId=${encodeURIComponent(organisationId)}`, { method: "DELETE" });
      setOlder((current) => current.filter((entry) => entry.id !== message.id));
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const showOlder = olderMore ?? chat.data?.more ?? false;
  return (
    <div className={styles.chat} ref={chatRef} data-room={room.kind} data-in-app={inChatApp ? "chat" : undefined}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {chat.error ? <Notice tone="error">{chat.error}</Notice> : null}
      <RefreshProblem problem={chat.refreshError} loadedAt={chat.loadedAt} onRetry={reload} />
      <div className={styles.list}>
        {showOlder ? (
          <button type="button" className={styles.older} onClick={() => void loadOlder()}>
            Show older messages
          </button>
        ) : null}
        {chat.data && messages.length === 0 ? <p className={styles.empty}>{farm ? <>No messages yet. Say what&apos;s happening on {roomName}.</> : <>No messages yet. Say hello.</>}</p> : null}
        <ol>
          {messages.map((message) => (
            <ChatBubble key={message.id} api={endpoints.files} message={message} organisationId={organisationId} onRemove={!message.removed && (message.mine || canRemoveAny) ? remove : undefined} />
          ))}
        </ol>
      </div>
      {canPost ? (
        <form
          ref={composeRef}
          className={styles.compose}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {voice.problem ? <Notice tone="error">{voice.problem}</Notice> : null}
          {voice.note ? (
            <div className={styles.voice}>
              <audio controls src={voice.note.url} aria-label="Your voice note" />
              <span>{voiceLength(voice.note.seconds)}</span>
              <button type="button" className={styles.chip} onClick={voice.clear}>
                Remove voice note
              </button>
            </div>
          ) : null}
          {links.length || photos.length ? (
            <div className={styles.chips}>
              {links.map((link) => (
                <button key={`${link.kind}-${link.id}`} type="button" className={styles.chip} onClick={() => setLinks(links.filter((entry) => entry !== link))} aria-label={`Remove ${link.label}`}>
                  {link.label} ×
                </button>
              ))}
              {photos.map((file, index) => (
                <button key={`${file.name}-${index}`} type="button" className={styles.chip} onClick={() => setPhotos(photos.filter((_, at) => at !== index))} aria-label={`Remove ${file.name}`}>
                  📷 {file.name} ×
                </button>
              ))}
            </div>
          ) : null}
          {members ? (
            <MentionPicker
              text={body}
              caret={caret}
              people={members}
              onPick={(next, nextCaret, person) => {
                setBody(next);
                setMentioned((current) => (current.some((entry) => entry.userId === person.userId) ? current : [...current, person]));
                setCaret(nextCaret);
                requestAnimationFrame(() => {
                  textRef.current?.focus();
                  textRef.current?.setSelectionRange(nextCaret, nextCaret);
                });
              }}
            />
          ) : null}
          <textarea
            ref={textRef}
            value={body}
            maxLength={4000}
            rows={2}
            placeholder={`Message ${roomName}`}
            aria-label="Message"
            onChange={(event) => {
              setBody(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className={styles.tools}>
            <label className={styles.tool}>
              Photo
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic"
                capture="environment"
                multiple
                onChange={(event) => {
                  const chosen = [...(event.target.files ?? [])];
                  event.target.value = "";
                  setPhotos((current) => [...current, ...chosen].slice(0, 6));
                }}
              />
            </label>
            {voice.recording ? (
              <button type="button" className={`${styles.tool} ${styles.recording}`} onClick={voice.stop} aria-label="Stop recording">
                ■ Stop {voiceLength(voice.elapsed)}
              </button>
            ) : (
              <button
                type="button"
                className={styles.tool}
                onClick={() => void voice.start()}
                aria-label={voice.note ? "Record the voice note again" : "Record a voice note"}
              >
                {voice.note ? "Redo" : "Voice"}
              </button>
            )}
            {farm ? (
              <select
                className={styles.about}
                value=""
                aria-label="About a paddock, mob or task"
                onChange={(event) => {
                  const picked = choices.find((choice) => `${choice.kind}:${choice.id}` === event.target.value);
                  if (picked && !links.some((link) => link.kind === picked.kind && link.id === picked.id)) setLinks([...links, picked].slice(0, 10));
                }}
              >
                <option value="">About…</option>
                {(["paddock", "mob", "task"] as const).map((kind) => {
                  const group = choices.filter((choice) => choice.kind === kind);
                  return group.length ? (
                    <optgroup key={kind} label={kind === "paddock" ? "Paddocks" : kind === "mob" ? "Mobs" : "Tasks"}>
                      {group.map((choice) => (
                        <option key={`${kind}:${choice.id}`} value={`${kind}:${choice.id}`}>
                          {choice.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </select>
            ) : null}
            <Button type="submit" disabled={busy || voice.recording || (!body.trim() && photos.length === 0 && !voice.note)}>
              {busy ? "Sending…" : "Send"}
            </Button>
          </div>
        </form>
      ) : (
        <p className={styles.empty}>{room.kind === "room" && room.readOnlyBecause ? room.readOnlyBecause : "You can read this farm's chat. Posting in it needs farm staff or the bookkeeper role or higher."}</p>
      )}
      <div ref={endRef} className={styles.end} />
    </div>
  );
}

/** Messages about a paddock or mob (FCH4), on its timeline. */
export function ChatAbout({ organisationId, kind, recordId }: { organisationId: string; kind: "paddock" | "mob"; recordId: string }) {
  const about = useApiData<{ messages: Named[] }>("/api/farming/chat/about", { organisationId, kind, recordId });
  const messages = about.data?.messages ?? [];
  if (messages.length === 0) return null;
  return (
    <section className={styles.aboutList} aria-label="From the farm chat">
      <h2>From the farm chat</h2>
      <ol>
        {messages.map((message) => (
          <ChatBubble key={message.id} message={message} organisationId={organisationId} />
        ))}
      </ol>
    </section>
  );
}
