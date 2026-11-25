/*
 * Whether an email's sender is who the From line says. The receiving mail
 * service checks this when the message arrives (SPF, DKIM and DMARC) and
 * writes what it found in an Authentication-Results header at the top of the
 * message. Anyone can put such a header in a message they send, so only the
 * top one, which the receiving service added last, is read.
 *
 * "pass": DMARC passed, or a DKIM signature from the From address's own
 * domain (or its parent domain) passed. "fail": the service checked and it
 * didn't pass. "unknown": no result to go on.
 */

export type SenderCheck = "pass" | "fail" | "unknown";

/** The domain of an address like "Bank <statements@mail.bank.example>". */
export function fromDomain(from: string | null | undefined): string | null {
  if (!from) return null;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  const address = (angle ? angle[1] : from).trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  const domain = address.slice(at + 1).replace(/[>\s]+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}

/** Same organisational domain, near enough: equal, or one inside the other ("mail.bank.example" and "bank.example"). */
function aligned(signer: string, from: string): boolean {
  return signer === from || from.endsWith(`.${signer}`) || signer.endsWith(`.${from}`);
}

/** Reads the topmost Authentication-Results header (`results` in the message's order, top first). */
export function senderCheck(results: ReadonlyArray<string>, from: string | null | undefined): SenderCheck {
  const top = results.find((value) => value.trim());
  if (!top) return "unknown";
  const domain = fromDomain(from);
  const text = top.replace(/\s+/g, " ").toLowerCase();
  // Each method result: "dmarc=pass (...) header.from=bank.example", "dkim=pass header.d=bank.example ...".
  const parts = text.split(";").map((part) => part.trim());
  let checked = false;
  for (const part of parts) {
    const method = /^(dmarc|dkim|spf)=([a-z]+)/.exec(part);
    if (!method) continue;
    checked = true;
    const [, name, result] = method;
    if (result !== "pass" || !domain) continue;
    if (name === "dmarc") {
      const headerFrom = /header\.from=([a-z0-9.-]+)/.exec(part)?.[1];
      if (!headerFrom || aligned(headerFrom, domain)) return "pass";
    }
    if (name === "dkim") {
      const signer = /header\.(?:d|i)=@?([a-z0-9.-]+)/.exec(part)?.[1];
      if (signer && aligned(signer, domain)) return "pass";
    }
  }
  return checked ? "fail" : "unknown";
}

/** Authentication-Results values from raw header text (folded lines joined), top first. */
export function authenticationResultsFrom(rawHeaders: string): string[] {
  const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, " ");
  return unfolded
    .split(/\r?\n/)
    .filter((line) => /^authentication-results:/i.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1).trim());
}
