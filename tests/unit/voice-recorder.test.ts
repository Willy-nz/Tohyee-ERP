import { describe, expect, it } from "vitest";
import { pickVoiceFormat, voiceLength } from "@/components/voice-recorder";
import { voiceType } from "@/lib/farming/chat";

describe("voice notes (FCH9)", () => {
  it("records MP4 where it can, as every phone plays it, then WebM or Ogg", () => {
    expect(pickVoiceFormat(() => true)).toBe("audio/mp4");
    expect(pickVoiceFormat((type) => type.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickVoiceFormat((type) => type.startsWith("audio/ogg"))).toBe("audio/ogg;codecs=opus");
    expect(pickVoiceFormat(() => false)).toBeUndefined();
  });

  it("shows a length as m:ss", () => {
    expect(voiceLength(0)).toBe("0:00");
    expect(voiceLength(42)).toBe("0:42");
    expect(voiceLength(180)).toBe("3:00");
  });

  it("tells a recording's format from its first bytes", () => {
    expect(voiceType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))?.contentType).toBe("audio/webm");
    expect(voiceType(new Uint8Array(Buffer.from("OggS")))?.contentType).toBe("audio/ogg");
    expect(voiceType(new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A ")])))?.contentType).toBe("audio/mp4");
    expect(voiceType(new Uint8Array(Buffer.from("hello there!")))).toBeNull();
  });
});
