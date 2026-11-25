import { describe, expect, it } from "vitest";
import { authenticationResultsFrom, fromDomain, senderCheck } from "@/lib/email/sender-check";

/** Reading the mail service's check of who sent an email. All addresses are made up. */
describe("sender check", () => {
  const from = "Bank <statements@mail.bank.example>";

  it("passes on DMARC, or DKIM from the From address's own domain", () => {
    expect(senderCheck(["mx.example; dmarc=pass (p=reject) header.from=mail.bank.example"], from)).toBe("pass");
    expect(senderCheck(["mx.example; dkim=pass header.d=bank.example; spf=pass"], from)).toBe("pass");
    expect(senderCheck(["mx.example; dkim=pass header.i=@bank.example"], from)).toBe("pass");
  });

  it("fails when the check didn't pass, or the signature is someone else's domain", () => {
    expect(senderCheck(["mx.example; dmarc=fail header.from=bank.example; dkim=none"], from)).toBe("fail");
    expect(senderCheck(["mx.example; dkim=pass header.d=elsewhere.example; dmarc=fail"], from)).toBe("fail");
    expect(senderCheck(["mx.example; spf=pass smtp.mailfrom=elsewhere.example"], from)).toBe("fail");
  });

  it("reads only the top header, which the receiving service added, and says when there's nothing to go on", () => {
    expect(senderCheck(["mx.example; dmarc=fail header.from=bank.example", "forged; dmarc=pass header.from=bank.example"], from)).toBe("fail");
    expect(senderCheck([], from)).toBe("unknown");
    expect(senderCheck(["mx.example; none"], from)).toBe("unknown");
  });

  it("finds the domain and the headers in raw text", () => {
    expect(fromDomain(from)).toBe("mail.bank.example");
    expect(fromDomain("someone@Bank.Example")).toBe("bank.example");
    expect(fromDomain("not an address")).toBeNull();
    expect(authenticationResultsFrom("Authentication-Results: mx.example;\r\n dmarc=pass header.from=bank.example\r\nAuthentication-Results: older; dkim=fail\r\n")).toEqual([
      "mx.example; dmarc=pass header.from=bank.example",
      "older; dkim=fail",
    ]);
  });
});
