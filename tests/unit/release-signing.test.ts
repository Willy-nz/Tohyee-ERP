import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Signing releases (UPD14-UPD19). The signature checks themselves run on
 * Windows (installer/windows/test-release-signature.ps1, in the Windows
 * installer workflow); these check what can be checked here: the keys file
 * the installer ships, and that the signing secrets only reach the small
 * jobs that sign.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** The jobs of a workflow, as text, by name (two-space indented keys under jobs:). */
function jobs(workflow: string): Map<string, string> {
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + 7);
  const found = new Map<string, string>();
  const parts = body.split(/^ {2}(?=[\w-]+:\s*$)/m).filter((part) => part.trim().length > 0);
  for (const part of parts) {
    const name = /^([\w-]+):/.exec(part)?.[1];
    if (name) found.set(name, part);
  }
  return found;
}

describe("the public keys the Windows installer ships (release-keys.txt)", () => {
  const lines = read("installer/windows/release-keys.txt")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  it("holds only public keys, never a private one", () => {
    for (const line of lines) {
      expect(line, "a private key in release-keys.txt").not.toContain("<D>");
      expect(line).toMatch(/^<RSAKeyValue><Modulus>[A-Za-z0-9+/=]+<\/Modulus><Exponent>[A-Za-z0-9+/=]+<\/Exponent><\/RSAKeyValue>$/);
    }
  });

  it("each key is a real RSA key of at least 2048 bits", () => {
    for (const line of lines) {
      const modulus = /<Modulus>([^<]+)<\/Modulus>/.exec(line)![1];
      const exponent = /<Exponent>([^<]+)<\/Exponent>/.exec(line)![1];
      const toUrl = (b64: string) => Buffer.from(b64, "base64").toString("base64url");
      const key = createPublicKey({ key: { kty: "RSA", n: toUrl(modulus), e: toUrl(exponent) }, format: "jwk" });
      expect(key.asymmetricKeyDetails?.modulusLength ?? 0).toBeGreaterThanOrEqual(2048);
    }
  });

  it("is installed with the updater, and both checks use the same format", () => {
    const build = read("installer/windows/build.ps1");
    expect(build).toContain("'release-signature.ps1', 'release-keys.txt'");
    const script = read("installer/windows/release-signature.ps1");
    const tray = read("installer/windows/tray/src/ReleaseSignature.cs");
    for (const text of [script, tray]) {
      expect(text).toContain("Tohyee release signature 1");
      expect(text).toMatch(/RSASignaturePadding\]?(::|\.)Pss/);
    }
    expect(read("installer/windows/tohyee-updater.ps1")).toContain("Test-TohyeeReleaseSignature");
  });
});

describe("signing secrets in the release workflows", () => {
  it("the Windows signing key only reaches the sign job, only on a release tag, with no npm", () => {
    const workflow = read(".github/workflows/windows-installer.yml");
    const byJob = jobs(workflow);
    expect([...byJob.keys()]).toEqual(expect.arrayContaining(["installer", "sign", "release"]));
    for (const [name, text] of byJob) {
      if (name === "sign") continue;
      expect(text, `${name} job`).not.toContain("TOHYEE_RELEASE_SIGNING_KEY }}");
    }
    const sign = byJob.get("sign")!;
    expect(sign).not.toMatch(/npm (ci|install|run)/);
    const step = sign.slice(sign.indexOf("- name: Sign it"), sign.indexOf("- name: Check signing works"));
    expect(step).toContain("secrets.TOHYEE_RELEASE_SIGNING_KEY");
    expect(step).toContain("if: startsWith(github.ref, 'refs/tags/v')");
    // The release waits for the signature and uploads it before the installer.
    const release = byJob.get("release")!;
    expect(release).toContain("needs: [installer, sign]");
    expect(release.indexOf('gh release upload "$tag" "$sig"')).toBeLessThan(release.indexOf("TohyeeSetup-*.exe.sha256"));
  });

  it("the Android release key only reaches the sign job, and an unsigned release says so in its notes", () => {
    const workflow = read(".github/workflows/android-app.yml");
    const byJob = jobs(workflow);
    for (const [name, text] of byJob) {
      if (name === "sign") continue;
      expect(text, `${name} job`).not.toMatch(/secrets\.ANDROID_/);
    }
    expect(byJob.get("sign")!).not.toMatch(/npm (ci|install|run)|gradlew/);
    expect(byJob.get("publish")!).toContain("add-release-note.sh");
  });
});
