import { describe, expect, it } from "vitest";
import { ROLES, teamChatAllows } from "@/lib/auth/roles";
import {
  CHAT_PRIVACY_LINE,
  canManageSpace,
  directPeople,
  insertMention,
  MAX_DIRECT_PEOPLE,
  mentionQuery,
  parseChatRef,
  peopleKey,
  spaceName,
} from "@/lib/chat/rules";

const ids = (count: number) => Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);

/** Chat rules (TCH12-TCH19, details following common practice, not yet reviewed). */
describe("direct messages (TCH12, TCH13)", () => {
  const [bea, ben, sam] = ids(3);

  it("are known by who's in them, in any order", () => {
    expect(peopleKey([ben, bea])).toBe(peopleKey([bea, ben]));
    expect(peopleKey([bea, ben, sam])).not.toBe(peopleKey([bea, ben]));
    expect(peopleKey([bea.toUpperCase(), ben])).toBe(peopleKey([bea, ben]));
  });

  it("need someone else, and take up to 12 people with you", () => {
    expect(directPeople(bea, [ben, ben, bea])).toEqual([bea, ben].sort());
    expect(() => directPeople(bea, [])).toThrow("Choose who to message.");
    expect(() => directPeople(bea, [bea])).toThrow("Choose who to message.");
    expect(directPeople(bea, ids(12).slice(1))).toHaveLength(MAX_DIRECT_PEOPLE);
    expect(() => directPeople(bea, [...ids(12).slice(1), "00000000-0000-4000-8000-000000000099"])).toThrow(
      "A direct message can have up to 12 people. Make a space for a bigger group.",
    );
    expect(() => directPeople(bea, ["not a person"])).toThrow("Choose people from the list.");
  });
});

describe("space names (TCH14)", () => {
  it("are trimmed, up to 80 characters, and never Everyone", () => {
    expect(spaceName("  Stock   take ")).toBe("Stock take");
    expect(() => spaceName("")).toThrow("Give the space a name.");
    expect(() => spaceName("x".repeat(81))).toThrow("A space's name can be up to 80 characters.");
    expect(() => spaceName("everyone")).toThrow("Everyone is the chat for the whole team. Choose another name.");
  });
});

describe("who manages a space (TCH16)", () => {
  it("is its maker, or an owner or admin", () => {
    expect(canManageSpace("bookkeeper", true)).toBe(true);
    expect(canManageSpace("bookkeeper", false)).toBe(false);
    expect(canManageSpace("sales_rep", false)).toBe(false);
    expect(canManageSpace("admin", false)).toBe(true);
    expect(canManageSpace("owner", false)).toBe(true);
  });
});

describe("mentions (TCH18)", () => {
  it("offers people while an @ word is being typed", () => {
    expect(mentionQuery("Thanks @Be", 10)).toEqual({ start: 7, query: "Be" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("email me@example", 16)).toBeNull();
    expect(mentionQuery("@Ben done", 9)).toBeNull();
    expect(mentionQuery("no at here", 5)).toBeNull();
  });

  it("puts the name in, with a space after", () => {
    expect(insertMention("Thanks @Be", 7, 10, "Ben Tui")).toEqual({ text: "Thanks @Ben Tui ", caret: 16 });
    expect(insertMention("@ how?", 0, 1, "Sam")).toEqual({ text: "@Sam  how?", caret: 5 });
  });
});

describe("chat ids (TCH17, TCH22)", () => {
  it("are a long random code, or a farm's chat", () => {
    expect(parseChatRef("3f2b8c1e-9d4a-4b6e-8f0a-1c2d3e4f5a6b")).toEqual({ kind: "room", id: "3f2b8c1e-9d4a-4b6e-8f0a-1c2d3e4f5a6b" });
    expect(parseChatRef("farm:12")).toEqual({ kind: "farm", farmId: "12" });
    expect(parseChatRef("12")).toBeNull();
    expect(parseChatRef("farm:x")).toBeNull();
    expect(parseChatRef(null)).toBeNull();
  });
});

describe("who can read it (TCH19)", () => {
  it("is said plainly", () => {
    expect(CHAT_PRIVACY_LINE).toBe("Owners and admins of this organisation can read this chat if they need to.");
  });
});

describe("who's in Chat, by role (TCH6, TCH27)", () => {
  it("is everyone but farm staff and report viewers, and everyone in it posts, viewers too", () => {
    const allowed = ROLES.filter((role) => teamChatAllows(role, "read"));
    expect(allowed).toEqual(["sales_rep", "sales_manager", "viewer", "bookkeeper", "admin", "owner"]);
    expect(ROLES.filter((role) => teamChatAllows(role, "post"))).toEqual(allowed);
    expect(teamChatAllows("farm_worker", "read")).toBe(false);
    expect(teamChatAllows("report_viewer", "read")).toBe(false);
  });

  it("leaves a space's managing to its maker, owners and admins, viewers or not", () => {
    expect(canManageSpace("viewer", true)).toBe(true);
    expect(canManageSpace("viewer", false)).toBe(false);
  });
});
