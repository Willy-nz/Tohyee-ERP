import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
const permissions = [...manifest.matchAll(/<uses-permission android:name="([^"]+)" \/>/g)].map((match) => match[1]);

describe("the Android app's permissions", () => {
  it("can use the microphone for voice notes in farm chat (FCH9), which Android asks about the first time", () => {
    expect(permissions).toEqual(expect.arrayContaining(["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"]));
  });

  it("only talks to servers over https", () => {
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
  });
});
