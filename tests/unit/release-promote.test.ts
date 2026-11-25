import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A release isn't GitHub's "latest" (what servers update to, Docker's :latest
 * and the website's Download use) until every one of its files is attached
 * (review 06, H2). scripts/promote-release.sh is run with fake gh and docker
 * commands that record what they were asked to do.
 */

const script = path.join(process.cwd(), "scripts", "promote-release.sh");
const workflows = path.join(process.cwd(), ".github", "workflows");

let bin: string;
let calls: string;

function fake(name: string, body: string) {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Runs the script for v1.2.0 with these assets on the release and `latest` as GitHub's current latest. */
function promote(assets: string[], latest = "v1.1.0") {
  fake(
    "gh",
    `if [ "$1 $2" = "release view" ] && [ "$3" = "--json" ]; then echo "${latest}"; exit 0; fi
if [ "$1 $2" = "release view" ]; then printf '%s\\n' ${assets.map((a) => `'${a}'`).join(" ")}; exit 0; fi
exit 0`,
  );
  fake("docker", "exit 0");
  const result = spawnSync("bash", [script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TAG: "v1.2.0", GH_REPO: "example/tohyee", PROMOTE_DOCKER: "yes" },
    encoding: "utf8",
  });
  let recorded = "";
  try {
    recorded = readFileSync(calls, "utf8");
  } catch {
    recorded = "";
  }
  return { status: result.status, out: result.stdout + result.stderr, calls: recorded };
}

const everything = [
  "TohyeeSetup-1.2.0.exe",
  "TohyeeSetup-1.2.0.exe.sha256",
  "tohyee-v1.2.0-linux-x64.tar.gz",
  "tohyee-v1.2.0-linux-x64.tar.gz.sha256",
  "tohyee-v1.2.0-windows-docker.zip",
  "tohyee-v1.2.0-windows-docker.zip.sha256",
  "Tohyee-1.2.0-test.apk",
  "Tohyee-1.2.0-test.apk.sha256",
];

beforeEach(() => {
  bin = mkdtempSync(path.join(os.tmpdir(), "tohyee-promote-"));
  calls = path.join(bin, "calls.txt");
});

afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
});

describe("Releases become the latest only once every file is there", () => {
  it("waits while any file is missing, without touching the release or Docker", () => {
    for (const missing of everything.filter((name) => !name.endsWith(".apk.sha256"))) {
      rmSync(calls, { force: true });
      const result = promote(everything.filter((name) => name !== missing));
      expect(result.status, missing).toBe(0);
      expect(result.out, missing).toContain("waiting for");
      expect(result.calls, missing).not.toContain("release edit");
      expect(result.calls, missing).not.toContain("docker");
    }
  });

  it("makes it the latest, and moves Docker's :latest, when everything is attached", () => {
    const result = promote(everything);
    expect(result.status).toBe(0);
    expect(result.calls).toContain("docker buildx imagetools create -t ghcr.io/willy-nz/tohyee:latest ghcr.io/willy-nz/tohyee:1.2.0");
    expect(result.calls).toContain("docker buildx imagetools create -t ghcr.io/willy-nz/tohyee-postbox:latest ghcr.io/willy-nz/tohyee-postbox:1.2.0");
    expect(result.calls).toContain("gh release edit v1.2.0 --latest");
  });

  it("accepts a signed APK as well as the test one, but not another version's", () => {
    const signed = everything.map((name) => name.replace("-test.apk", ".apk"));
    expect(promote(signed).calls).toContain("release edit v1.2.0 --latest");
    rmSync(calls, { force: true });
    const other = everything.map((name) => name.replace("Tohyee-1.2.0-test.apk", "Tohyee-1.2.01-test.apk"));
    expect(promote(other).calls).not.toContain("release edit");
  });

  it("never makes an older release the latest", () => {
    const result = promote(everything, "v1.10.0");
    expect(result.status).toBe(0);
    expect(result.calls).not.toContain("release edit");
  });

  it("is what every release build runs, and the release is made with --latest=false", () => {
    const onVersion = readFileSync(path.join(workflows, "release-on-version.yml"), "utf8");
    expect(onVersion).toMatch(/gh release create "\$TAG" [^\n]*--latest=false/);
    for (const name of ["release-server-bundle.yml", "windows-installer.yml", "android-app.yml"]) {
      const text = readFileSync(path.join(workflows, name), "utf8");
      expect(text, name).toContain("scripts/promote-release.sh");
      // A build that has to make the release itself doesn't make it the latest either.
      for (const create of text.match(/gh release create[^\n]*/g) ?? []) expect(create, name).toContain("--latest=false");
      // Docker's :latest only moves in the promote step.
      expect(text, name).not.toMatch(/tohyee(-postbox)?:latest\s*$/m);
    }
  });
});
