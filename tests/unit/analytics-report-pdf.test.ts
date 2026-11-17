import { describe, expect, it } from "vitest";
import { pdfFileName } from "@/components/analytics/report-pdf";

/** : Download PDF names the file after the report. */
describe("Download PDF's file name", () => {
  it("keeps letters, numbers, spaces and dashes", () => {
    expect(pdfFileName("Glenmore: November 2026 / overview")).toBe("Glenmore November 2026 overview.pdf");
    expect(pdfFileName("Māori-owned sales")).toBe("Māori-owned sales.pdf");
    expect(pdfFileName("///")).toBe("Report.pdf");
  });
});
