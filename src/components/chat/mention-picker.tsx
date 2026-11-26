"use client";

import { insertMention, mentionQuery } from "@/lib/chat/rules";
import styles from "./chat.module.css";

/** Someone who can be mentioned in a chat (TCH18). */
export type MentionPerson = { userId: string; name: string };

/** The people picked who are still named with @ in the words, so a deleted mention isn't sent. */
export function mentionsStillIn(text: string, picked: readonly MentionPerson[]): MentionPerson[] {
  return picked.filter((person) => text.includes(`@${person.name}`));
}

/**
 * While an @word is being typed, the chat's people whose names match, to tap
 * (TCH18). Tapping one puts "@Name " in the words.
 */
export function MentionPicker({ text, caret, people, onPick }: { text: string; caret: number; people: readonly MentionPerson[]; onPick: (text: string, caret: number, person: MentionPerson) => void }) {
  const typing = mentionQuery(text, caret);
  if (!typing) return null;
  const query = typing.query.toLowerCase();
  const matches = people.filter((person) => person.name.toLowerCase().split(/\s+/).some((word) => word.startsWith(query)) || person.name.toLowerCase().startsWith(query)).slice(0, 8);
  if (matches.length === 0) return null;
  return (
    <ul className={styles.mentionList} aria-label="Mention someone">
      {matches.map((person) => (
        <li key={person.userId}>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const next = insertMention(text, typing.start, caret, person.name);
              onPick(next.text, next.caret, person);
            }}
          >
            @{person.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
