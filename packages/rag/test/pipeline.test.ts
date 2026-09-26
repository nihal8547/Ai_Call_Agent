import { describe, expect, it } from "vitest";
import { chunkBlocks, cleanBlocks, DocumentError, detectFileKind, extract, type Block } from "../src";
import { makeDocx, makePdf, makeScannedPdf, makeXlsx } from "./fixtures";

describe("detectFileKind (by content, not by name)", () => {
  it("recognises real formats", async () => {
    expect(detectFileKind(await makePdf(), "x.bin")).toBe("pdf");
    expect(detectFileKind(await makeDocx(), "notes.pdf")).toBe("docx");
    expect(detectFileKind(await makeXlsx(), "sheet")).toBe("xlsx");
    expect(detectFileKind(Buffer.from("a,b\n1,2"), "prices.csv")).toBe("csv");
    expect(detectFileKind(Buffer.from("# Title\ntext"), "faq.md")).toBe("md");
    expect(detectFileKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), "a.png")).toBe("png");
  });

  it("rejects binaries pretending to be text and unknown zips", () => {
    expect(detectFileKind(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), "setup.txt")).toBeNull(); // Windows exe
    expect(detectFileKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "archive.docx")).toBeNull();
    expect(detectFileKind(Buffer.from([0xc3, 0x28]), "bad.txt")).toBeNull(); // invalid UTF-8
    expect(detectFileKind(Buffer.alloc(0), "empty.txt")).toBeNull();
  });
});

describe("extraction", () => {
  it("PDF: paragraphs per page; cleaning removes running headers and page numbers", async () => {
    const { blocks, pageCount, needsOcr } = await extract("pdf", await makePdf(), null);
    expect([pageCount, needsOcr]).toEqual([4, false]);
    const cleaned = cleanBlocks(blocks);
    const texts = cleaned.map((b) => b.text).join(" | ");
    expect(texts).toContain("A consultation costs 500 rupees.");
    expect(texts).not.toMatch(/Smile Dental Clinic Brochure|Page \d of 4/);
    expect(cleaned.find((b) => b.text.includes("basement"))?.meta.page).toBe(4);
    expect(cleaned.filter((b) => b.kind === "heading").map((b) => b.text)).toEqual([
      "Our services",
      "Timings",
      "Pricing",
      "Parking",
    ]);
    // Each page's section becomes the chunk's context line
    const chunks = chunkBlocks(cleaned);
    expect(chunks.find((c) => c.content.includes("500 rupees"))!.content).toBe(
      "Pricing\nA consultation costs 500 rupees. Implants start at 25,000 rupees.",
    );
    expect(chunks.find((c) => c.content.includes("basement"))!.metadata.headingPath).toEqual(["Parking"]);
  });

  it("scanned PDFs go through OCR, or fail clearly without it", async () => {
    const scan = await makeScannedPdf();
    await expect(extract("pdf", scan, null)).rejects.toBeInstanceOf(DocumentError);
    const ocr = { pages: async () => ["# Menu\nPaneer tikka 320\n\nDal makhani 280"] };
    const { blocks, needsOcr } = await extract("pdf", scan, ocr);
    expect(needsOcr).toBe(true);
    expect(blocks[0]).toMatchObject({ kind: "heading", text: "Menu", meta: { page: 1 } });
  });

  it("DOCX: headings, paragraphs and tables as self-contained records", async () => {
    const { blocks } = await extract("docx", await makeDocx(), null);
    expect(blocks.filter((b) => b.kind === "heading").map((b) => [b.text, b.level])).toEqual([
      ["Sunrise Residency", 1],
      ["Rooms", 2],
      ["Policies", 2],
    ]);
    expect(blocks.filter((b) => b.kind === "record").map((b) => b.text)).toEqual([
      "Room: Deluxe; Price per night: 4,500; Max guests: 2",
      "Room: Suite; Price per night: 9,000; Max guests: 4",
    ]);
    expect(blocks.some((b) => b.text === "All rooms include free Wi-Fi & air conditioning.")).toBe(true);
  });

  it("XLSX and CSV: one record per row, with sheet and row numbers", async () => {
    const { blocks } = await extract("xlsx", await makeXlsx(), null);
    const records = blocks.filter((b) => b.kind === "record");
    expect(records[0]).toMatchObject({
      text: "Project: Green Heights; Location: Baner; Price from: 8500000; Possession: 2027-03-01",
      meta: { sheet: "Projects", row: 2 },
    });
    expect(records.at(-1)).toMatchObject({
      text: "Question: Is parking included?; Answer: Yes, one covered spot per flat.",
      meta: { sheet: "FAQ" },
    });

    const csv = await extract("csv", Buffer.from('﻿Plan,Price\n"Gold, yearly",4999\n\nSilver,1999\n'), null);
    expect(csv.blocks.map((b) => b.text)).toEqual([
      "Plan: Gold, yearly; Price: 4999",
      "Plan: Silver; Price: 1999",
    ]);
  });
});

describe("chunkBlocks", () => {
  it("prefixes the section, keeps records whole and starts new sections in new chunks", async () => {
    const { blocks } = await extract("docx", await makeDocx(), null);
    const chunks = chunkBlocks(cleanBlocks(blocks));
    expect(chunks.map((c) => c.content)).toEqual([
      "Sunrise Residency > Rooms\nAll rooms include free Wi-Fi & air conditioning.\nRoom: Deluxe; Price per night: 4,500; Max guests: 2\nRoom: Suite; Price per night: 9,000; Max guests: 4",
      "Sunrise Residency > Policies\nCheck-in is from 2 PM. Check-out is until 11 AM.",
    ]);
    expect(chunks[1]!.metadata.headingPath).toEqual(["Sunrise Residency", "Policies"]);
  });

  it("splits long text near the target size with overlap between consecutive chunks", () => {
    const sentence = (i: number) =>
      `Sentence number ${i} explains one more detail about the clinic and its services.`;
    const blocks: Block[] = [
      { kind: "text", text: Array.from({ length: 80 }, (_, i) => sentence(i)).join(" "), meta: { page: 2 } },
    ];
    const chunks = chunkBlocks(blocks, { targetTokens: 200, maxTokens: 300, overlapTokens: 40 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(300);
    // the start of each chunk repeats the end of the previous one
    const lastSentenceOfFirst = chunks[0]!.content.match(/Sentence number \d+/g)!.at(-1)!;
    expect(chunks[1]!.content).toContain(lastSentenceOfFirst);
    expect(chunks.every((c) => c.metadata.page === 2)).toBe(true);
  });

  it("never splits a record, even a long one", () => {
    const record: Block = { kind: "record", text: `Notes: ${"x".repeat(4000)}`, meta: { row: 7 } };
    const chunks = chunkBlocks([record], { targetTokens: 100, maxTokens: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.metadata.rows).toEqual([7, 7]);
  });
});
