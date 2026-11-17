"use client";

/**
 * A report's sheets as a PDF made in the browser:
 * each sheet on the print page is drawn as a picture, exactly as it shows
 * on screen, and put on its own A4 page in the chosen paper's orientation.
 * The printer never decides anything, so "Microsoft Print to PDF" and
 * other printers that ignore the page's landscape setting can't turn it
 * portrait. Nothing is sent to the server. Text in the PDF is a picture,
 * so it can't be selected; printing or saving from the print window keeps
 * the text.
 */

/** A4 in PDF points. */
const A4 = { long: 841.89, short: 595.28 };
/** Pixels drawn per screen pixel: sharp when printed, with files of a few MB. */
const PIXEL_RATIO = 2;

export async function downloadReportPdf(sheets: HTMLElement[], paper: "landscape" | "portrait", fileName: string, progress: (done: number, of: number) => void): Promise<void> {
  const [{ toJpeg }, { PDFDocument }] = await Promise.all([import("html-to-image"), import("pdf-lib")]);
  const pdf = await PDFDocument.create();
  pdf.setTitle(fileName.replace(/\.pdf$/i, ""));
  pdf.setCreator("Tohyee");
  const [width, height] = paper === "portrait" ? [A4.short, A4.long] : [A4.long, A4.short];
  for (const [index, sheet] of sheets.entries()) {
    progress(index, sheets.length);
    const picture = await toJpeg(sheet, { quality: 0.92, pixelRatio: PIXEL_RATIO, backgroundColor: "#ffffff", cacheBust: false });
    const image = await pdf.embedJpg(picture);
    const page = pdf.addPage([width, height]);
    // The sheet is drawn at the paper's shape, so it fills the page; any difference is split evenly.
    const scale = Math.min(width / image.width, height / image.height);
    page.drawImage(image, { x: (width - image.width * scale) / 2, y: (height - image.height * scale) / 2, width: image.width * scale, height: image.height * scale });
  }
  progress(sheets.length, sheets.length);
  const bytes = await pdf.save();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

/** A file name from the report's name: letters, numbers, spaces and dashes. */
export function pdfFileName(reportName: string): string {
  const name = reportName.replace(/[^\p{L}\p{N} \-_.]+/gu, "").replace(/\s+/g, " ").trim().slice(0, 100);
  return `${name || "Report"}.pdf`;
}
