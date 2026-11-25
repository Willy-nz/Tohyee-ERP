import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_CODE_REPOSITORY, sourceCodeUrl } from "@/lib/source-code";

const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), "utf8");

describe("A link to Tohyee's own source code (AGPL section 13, review 06 L7)", () => {
  it("points at the running version's tag, or the repository", () => {
    expect(sourceCodeUrl("1.2.3")).toBe(`${SOURCE_CODE_REPOSITORY}/tree/v1.2.3`);
    expect(sourceCodeUrl("not a version")).toBe(SOURCE_CODE_REPOSITORY);
    expect(sourceCodeUrl(null)).toBe(SOURCE_CODE_REPOSITORY);
  });

  it("is on the sign-in page and in the account menus", () => {
    expect(read("src", "components", "auth", "login-form.tsx")).toMatch(/href=\{sourceCodeUrl\}[\s\S]{0,80}Source code/);
    expect(read("src", "app", "login", "page.tsx")).toContain("sourceCodeUrl={sourceCodeUrl(packageJson.version)}");
    const shell = read("src", "components", "app-shell.tsx");
    expect(shell.match(/href=\{SOURCE_CODE_REPOSITORY\}/g)?.length).toBe(2);
  });
});

describe("Docker Desktop on Windows (review 06 M1, M8)", () => {
  it("keeps backups in one full-path folder, not next to each release's own folder", () => {
    const install = read("deploy", "windows", "Install-Tohyee.ps1");
    // Set once, as a full path, and kept; an older install's folder is found from the running container.
    expect(install).toContain("$settings['TOHYEE_BACKUP_FOLDER'] = $backupFolder");
    expect(install).toContain("Join-Path $SettingsDir 'backups'");
    expect(install).toContain("Get-CurrentBackupFolder");
    expect(read("deploy", "windows", "README.txt")).not.toContain("extract it over the old folder");
  });

  it("says how to create the first organisation without the Windows tray", () => {
    expect(read("deploy", "windows", "README.txt")).toContain("tohyee-admin.cjs organisations create");
    expect(read("src", "components", "books.tsx")).toContain("tohyee-admin.cjs organisations create");
  });
});
