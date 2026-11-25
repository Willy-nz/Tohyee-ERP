"use client";

import { InfoTip } from "@/components/info-tip";
import { type FormEvent,useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge,Button,Card,Empty,Field,Notice,ui } from "@/components/ui";
import { api,errorMessage,newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { incomeYearLabel } from "@/lib/tax/income/rules";
import type { IrdDocument,IrdProposal } from "@/lib/tax/income/ird-documents";
import { postForm } from "@/components/rd";
import { Status } from "@/components/income-tax/shared";

const PROPOSED_FIELDS: Array<{ key: "assessedRit" | "returnFiledOn" | "lossesBroughtForward" | "taxCredits" | "imputationCredits" | "overseasTaxPaid" | "imputationBroughtForward" | "otherIncome"; label: string; date?: boolean }> = [
  { key: "assessedRit", label: "Assessed RIT" },
  { key: "returnFiledOn", label: "Return filed on", date: true },
  { key: "lossesBroughtForward", label: "Losses brought forward" },
  { key: "taxCredits", label: "Tax credits" },
  { key: "imputationCredits", label: "Imputation credits received" },
  { key: "overseasTaxPaid", label: "Overseas tax paid" },
  { key: "imputationBroughtForward", label: "Excess imputation credits brought forward" },
  { key: "otherIncome", label: "Other income" },
];

function ProposalCard({ organisationId, proposal, endMonth, onDone }: { organisationId: string; proposal: IrdProposal; endMonth: number; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(action: "accept" | "decline") {
    try {
      setError(null);
      await api(`/api/income-tax/proposals/${proposal.id}/${action}`, { method: "POST", body: { organisationId, reason: action === "decline" ? reason : undefined } });
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  const show = (value: string | null | undefined, date?: boolean) => (value == null ? <span className={ui.muted}>none</span> : date ? formatDate(value) : <Money value={value} />);
  return (
    <div className={ui.reportBlock}>
      <p>
        <strong>{incomeYearLabel(proposal.incomeYear, endMonth)}</strong> · proposed by {proposal.aiKeyName ?? proposal.proposedByEmail} on {formatDate(proposal.createdAt.slice(0, 10))}
        {proposal.documentId ? (
          <>
            {" "}
            from{" "}
            <a href={`/api/income-tax/documents/${proposal.documentId}/file?organisationId=${encodeURIComponent(organisationId)}`} target="_blank" rel="noreferrer">
              {proposal.documentName}
            </a>
          </>
        ) : null}
      </p>
      {proposal.note ? <p className={ui.muted}>“{proposal.note}”</p> : null}
      <div className={ui.tableWrap}>
        <table className={ui.reportTable}>
          <thead>
            <tr>
              <th />
              <th className={ui.num}>Now</th>
              <th className={ui.num}>Proposed</th>
            </tr>
          </thead>
          <tbody>
            {PROPOSED_FIELDS.filter((field) => proposal.figures[field.key] !== undefined).map((field) => (
              <tr key={field.key}>
                <td>{field.label}</td>
                <td className={ui.num}>{show(proposal.current[field.key], field.date)}</td>
                <td className={ui.num}>
                  <strong>{show(proposal.figures[field.key], field.date)}</strong>
                </td>
              </tr>
            ))}
            {proposal.payments.map((payment, index) => (
              <tr key={`payment-${index}`}>
                <td>
                  Payment on {formatDate(payment.paidOn)}
                  {payment.note ? <span className={ui.muted}> · {payment.note}</span> : null}
                </td>
                <td className={ui.num}>{payment.alreadyTyped ? <Badge>Already typed</Badge> : null}</td>
                <td className={ui.num}>
                  <strong>
                    <Money value={payment.amount} />
                  </strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {declining ? (
        <div className={ui.inlineForm}>
          <Field label="Why decline?">
            <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <Button variant="secondary" size="small" onClick={() => void decide("decline")}>
            Decline
          </Button>
          <Button variant="secondary" size="small" onClick={() => setDeclining(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className={ui.rowButtons}>
          <Button size="small" onClick={() => void decide("accept")}>
            Accept: I&apos;ve checked them against the document
          </Button>
          <Button variant="secondary" size="small" onClick={() => setDeclining(true)}>
            Decline…
          </Button>
        </div>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

export function IrdDocuments({ organisationId, incomeYear, years, endMonth, onChanged }: { organisationId: string; incomeYear: number; years: number[]; endMonth: number; onChanged: () => void }) {
  const loaded = useApiData<{ documents: IrdDocument[]; proposals: IrdProposal[] }>("/api/income-tax/documents", { organisationId });
  const [file, setFile] = useState<File | null>(null);
  const [year, setYear] = useState(String(incomeYear));
  const [note, setNote] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("ird-doc"));
  const [removing, setRemoving] = useState<{ id: string; reason: string } | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const refresh = () => {
    loaded.reload();
    onChanged();
  };
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setStatus({ tone: "error", text: `${file.name} is more than 10 MB.` });
      return;
    }
    const form = new FormData();
    form.set("organisationId", organisationId);
    form.set("idempotencyKey", key);
    form.set("file", file);
    if (year) form.set("incomeYear", year);
    if (note) form.set("note", note);
    try {
      await postForm("/api/income-tax/documents", form);
      setFile(null);
      setNote("");
      setKey(newIdempotencyKey("ird-doc"));
      setStatus(null);
      refresh();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function remove() {
    if (!removing) return;
    try {
      await api(`/api/income-tax/documents/${removing.id}/remove`, { method: "POST", body: { organisationId, reason: removing.reason } });
      setRemoving(null);
      refresh();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  const data = loaded.data;
  return (
    <Card
      title="IRD documents"
      description={<>Upload IRD&apos;s assessments, statements and letters from myIR. Nothing changes until you accept it. Tohyee never asks for your myIR password.{" "}<InfoTip label="Reading IRD's letters">Your connected AI can read them and propose the figures; nothing changes until you check and accept them. Tohyee never asks for your myIR password.</InfoTip></>}
    >
      {data && data.proposals.length > 0 ? (
        <>
          <h3>Proposed figures to check</h3>
          {data.proposals.map((proposal) => (
            <ProposalCard key={proposal.id} organisationId={organisationId} proposal={proposal} endMonth={endMonth} onDone={refresh} />
          ))}
        </>
      ) : null}
      {!data ? (
        <p className={ui.muted}>Loading…</p>
      ) : data.documents.length === 0 ? (
        <Empty picture="documents">No IRD documents yet.</Empty>
      ) : (
        <ul>
          {data.documents.map((document) => (
            <li key={document.id}>
              <a href={`/api/income-tax/documents/${document.id}/file?organisationId=${encodeURIComponent(organisationId)}`} target="_blank" rel="noreferrer">
                {document.fileName}
              </a>
              {document.incomeYear ? ` · ${document.incomeYear} income year` : ""}
              {document.note ? ` · ${document.note}` : ""}
              <span className={ui.muted}> · added {formatDate(document.createdAt.slice(0, 10))}</span>{" "}
              {removing?.id === document.id ? (
                <span className={ui.inlineForm}>
                  <input aria-label="Why remove it?" placeholder="Why remove it?" value={removing.reason} onChange={(event) => setRemoving({ id: document.id, reason: event.target.value })} />
                  <Button size="small" variant="secondary" onClick={() => void remove()}>
                    Remove
                  </Button>
                </span>
              ) : (
                <button type="button" className={ui.linkButton} onClick={() => setRemoving({ id: document.id, reason: "" })}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className={ui.inlineForm} onSubmit={upload}>
        <Field label="IRD file" hint="PDF, JPG, PNG or HEIC, up to 10 MB.">
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.heic" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
        </Field>
        <Field label="Income year">
          <select value={year} onChange={(event) => setYear(event.target.value)}>
            <option value="">Not sure</option>
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note">
          <input value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <Button type="submit" variant="secondary">
          Upload
        </Button>
      </form>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </Card>
  );
}
