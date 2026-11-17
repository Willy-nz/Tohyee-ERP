import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**: a tag can be moved to different code; a commit can't. */
describe("GitHub Actions in the workflows", () => {
  const folder = join(process.cwd(), ".github", "workflows");
  const uses = readdirSync(folder)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .flatMap((name) => [...readFileSync(join(folder, name), "utf8").matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)].map((match) => ({ file: name, action: match[1], rest: match[2] })));

  it("are each pinned to a full commit, with the version beside it for Dependabot and for people", () => {
    expect(uses.length).toBeGreaterThan(10);
    for (const use of uses) {
      // An action in this repository (./path) is already at this commit.
      if (use.action.startsWith("./")) continue;
      expect(use.action, `${use.file}: ${use.action}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(use.rest, `${use.file}: ${use.action}`).toMatch(/#\s*v\d/);
    }
  });
});
