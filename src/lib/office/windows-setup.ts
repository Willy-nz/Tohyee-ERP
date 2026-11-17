import { createHash } from "node:crypto";
import type { OfficeAddresses } from "@/lib/office/addin";

/** The shared folder's name, and the file the manifest is saved as in it. */
export const WINDOWS_SHARE_NAME = "TohyeePowerPoint";
export const WINDOWS_MANIFEST_FILE = "tohyee-powerpoint-addin.xml";

/**
 * The Trusted Add-in Catalog's key for this server: a GUID made from the
 * server's address, like the add-in's Id, so running the setup again
 * replaces the same catalog rather than adding another.
 */
export function windowsCatalogId(origin: string): string {
  const bytes = createHash("sha1").update(`tohyee-powerpoint-catalog:${origin.toLowerCase()}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`.toUpperCase();
}

/**
 * A Windows setup file (`.cmd`) that adds the PowerPoint add-in to desktop
 * PowerPoint on the PC it runs on, where PowerPoint has no Upload My
 * Add-in. It's Microsoft's way of loading an add-in that isn't in its
 * store: the manifest goes in a folder shared from this PC, and that share
 * is a Trusted Add-in Catalog (HKCU …\Office\16.0\WEF\TrustedCatalogs)
 * shown in PowerPoint's menu. Sharing the folder needs Windows'
 * administrator prompt once; the share lets only this PC's user read it.
 * It holds this server's public address only, like the manifest.
 */
export function windowsSetupScript(addresses: OfficeAddresses): string {
  const id = windowsCatalogId(addresses.origin);
  const key = `HKCU\\Software\\Microsoft\\Office\\16.0\\WEF\\TrustedCatalogs\\${id}`;
  const lines = [
    "@echo off",
    "setlocal",
    "title Add Tohyee Analytics to PowerPoint",
    "echo Adding Tohyee Analytics to PowerPoint on this PC.",
    "echo.",
    `set "DIR=%LOCALAPPDATA%\\Tohyee\\PowerPoint"`,
    `set "SHARE=${WINDOWS_SHARE_NAME}"`,
    `if not exist "%DIR%" mkdir "%DIR%"`,
    `curl.exe -fsSL "${addresses.manifestUrl}" -o "%DIR%\\${WINDOWS_MANIFEST_FILE}"`,
    "if errorlevel 1 (",
    `  echo Couldn't download the add-in from ${addresses.origin}. Check this PC can reach Tohyee, then run this again.`,
    "  pause",
    "  exit /b 1",
    ")",
    "net share %SHARE% >nul 2>&1",
    "if errorlevel 1 (",
    "  echo Windows will ask to let this share the folder with PowerPoint. Choose Yes.",
    // One argument string with its own quotes, so a folder or user name with spaces stays whole.
    `  powershell -NoProfile -Command "Start-Process -FilePath net.exe -ArgumentList 'share \\"%SHARE%=%DIR%\\" \\"/GRANT:%USERDOMAIN%\\%USERNAME%,READ\\"' -Verb RunAs -Wait"`,
    ")",
    "net share %SHARE% >nul 2>&1",
    "if errorlevel 1 (",
    "  echo The folder wasn't shared, so PowerPoint can't see the add-in. Run this again and choose Yes when Windows asks.",
    "  pause",
    "  exit /b 1",
    ")",
    `reg add "${key}" /v Id /t REG_SZ /d "${id}" /f >nul`,
    `reg add "${key}" /v Url /t REG_SZ /d "\\\\%COMPUTERNAME%\\%SHARE%" /f >nul`,
    `reg add "${key}" /v Flags /t REG_DWORD /d 1 /f >nul`,
    "echo Done.",
    "echo.",
    "echo 1. Close PowerPoint if it's open, and open it again.",
    "echo 2. Choose Insert ^> My Add-ins (or Home ^> Add-ins ^> My Add-ins), then the SHARED FOLDER tab.",
    "echo 3. Choose Tohyee Analytics and Add.",
    "echo.",
    "pause",
    "",
  ];
  return lines.join("\r\n");
}
