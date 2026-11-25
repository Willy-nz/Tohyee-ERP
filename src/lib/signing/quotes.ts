import type { OrgTx } from "@/lib/db/org-transaction";
import { todayIsoDate } from "@/lib/dates";
import { ConflictError, ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { getQuote } from "@/lib/quotes/service";
import { createSigningRequest, type SendContext, type SendResult } from "@/lib/signing/service";
import { DEFAULT_EXPIRY_DAYS } from "@/lib/signing/shared";

/** Whole days from one date to a later one. */
function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/*
 * A quote sent for the customer to accept by signing (QT9-QT11): the quote's PDF as it's printed is the document, and
 * one person at the customer signs. Signing accepts the quote with no
 * invoice yet; declining declines it. Accepting or declining it in Tohyee
 * voids the request.
 */

export async function sendQuoteForSigning(
  tx: OrgTx,
  quoteId: string,
  input: { source?: unknown; idempotencyKey: unknown; signers: unknown; message?: unknown; expiresInDays?: unknown; remindEveryDays?: unknown },
  pdf: { fileName: string; bytes: Uint8Array },
  context: SendContext,
): Promise<SendResult> {
  const quote = await getQuote(tx, quoteId);
  if (quote.status === "draft") throw new ConflictError("Finalise the quote before sending it to accept.");
  if (quote.status !== "finalised") throw new ConflictError(`${quote.quoteNumber} is already ${quote.status}.`);
  if (!Array.isArray(input.signers) || input.signers.length !== 1) throw new ValidationError("A quote is accepted by one person: choose who at the customer signs.");
  const open = await tx.query<{ id: string; idempotency_key: string; command_source: string }>(
    "select id::text, idempotency_key, command_source from signing_requests where source_kind = 'quote' and source_id = $1 and status = 'sent' and expires_at > now()",
    [quote.id],
  );
  const replay = open.rows[0] && open.rows[0].idempotency_key === input.idempotencyKey;
  if (open.rows[0] && !replay) throw new ConflictError(`${quote.quoteNumber} is already waiting for the customer to sign. Void that request first to send it again.`);
  // A quote past its own expiry date isn't sent to accept, and the link stops working when the quote does (OPF5).
  const today = todayIsoDate();
  let expiresInDays = input.expiresInDays;
  if (quote.expiryDate && !replay) {
    if (quote.expiryDate < today) throw new ConflictError(`${quote.quoteNumber} expired on ${formatDate(quote.expiryDate)}. Copy it to make a new quote with a new expiry date, then send that.`);
    const lastDay = daysFrom(today, quote.expiryDate) + 1;
    const asked = expiresInDays === undefined || expiresInDays === null || expiresInDays === "" ? DEFAULT_EXPIRY_DAYS : Number(expiresInDays);
    if (Number.isInteger(asked) && asked > lastDay) expiresInDays = lastDay;
  }
  const organisation = await getOrganisationSettings(tx);
  return createSigningRequest(
    tx,
    {
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      title: `Quote ${quote.quoteNumber} from ${organisation.displayName}`,
      sourceKind: "quote",
      sourceId: quote.id,
      fileName: pdf.fileName,
      bytes: pdf.bytes,
      signers: input.signers,
      signingOrder: "in_order",
      message: input.message,
      expiresInDays,
      remindEveryDays: input.remindEveryDays,
    },
    context,
  );
}
