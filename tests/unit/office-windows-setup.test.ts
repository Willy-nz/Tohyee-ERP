import { describe, expect, it } from "vitest";
import { officeAddressesFor } from "@/lib/office/addin";
import { windowsCatalogId, windowsSetupScript } from "@/lib/office/windows-setup";

describe("the Windows setup for the PowerPoint add-in", () => {
  const addresses = officeAddressesFor("https://books.example.nz")!;
  const script = windowsSetupScript(addresses);
  const lines = script.split("\r\n");

  it("is a Windows command file with Windows line endings", () => {
    expect(lines[0]).toBe("@echo off");
    expect(script).not.toMatch(/[^\r]\n/);
  });

  it("downloads this server's manifest into the user's own folder", () => {
    expect(script).toContain('set "DIR=%LOCALAPPDATA%\\Tohyee\\PowerPoint"');
    expect(script).toContain('curl.exe -fsSL "https://books.example.nz/office/powerpoint/manifest.xml" -o "%DIR%\\tohyee-powerpoint-addin.xml"');
  });

  it("shares the folder read-only to this user, asking Windows only when it isn't shared yet, with quotes kept for names with spaces", () => {
    expect(script).toContain("net share %SHARE% >nul 2>&1");
    expect(script).toContain(`-ArgumentList 'share \\"%SHARE%=%DIR%\\" \\"/GRANT:%USERDOMAIN%\\%USERNAME%,READ\\"' -Verb RunAs -Wait`);
  });

  it("adds the share as a Trusted Add-in Catalog shown in PowerPoint's menu, under a key that's the same each time for this server", () => {
    const id = windowsCatalogId("https://books.example.nz");
    expect(id).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/);
    expect(windowsCatalogId("https://BOOKS.example.nz")).toBe(id);
    expect(windowsCatalogId("https://other.example.nz")).not.toBe(id);
    const key = `HKCU\\Software\\Microsoft\\Office\\16.0\\WEF\\TrustedCatalogs\\${id}`;
    expect(script).toContain(`reg add "${key}" /v Id /t REG_SZ /d "${id}" /f >nul`);
    expect(script).toContain(`reg add "${key}" /v Url /t REG_SZ /d "\\\\%COMPUTERNAME%\\%SHARE%" /f >nul`);
    expect(script).toContain(`reg add "${key}" /v Flags /t REG_DWORD /d 1 /f >nul`);
  });

  it("says what to do next, with cmd's > escaped", () => {
    expect(script).toContain("echo 2. Choose Insert ^> My Add-ins (or Home ^> Add-ins ^> My Add-ins), then the SHARED FOLDER tab.");
  });
});
