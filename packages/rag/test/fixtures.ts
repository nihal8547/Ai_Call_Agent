import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** A 4-page clinic brochure with a running header, page numbers and real content */
export async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [
    [
      "Smile Dental Clinic Brochure",
      "Our services",
      "We offer dental implants, root canal treatment and teeth whitening.",
      "Implants are placed by Dr. Mehta, who has 15 years of experience.",
    ],
    [
      "Smile Dental Clinic Brochure",
      "Timings",
      "The clinic is open Monday to Saturday from 9 AM to 7 PM.",
      "Sunday is closed.",
    ],
    [
      "Smile Dental Clinic Brochure",
      "Pricing",
      "A consultation costs 500 rupees. Implants start at 25,000 rupees.",
    ],
    ["Smile Dental Clinic Brochure", "Parking", "Free parking is available in the basement for patients."],
  ];
  pages.forEach((lines, i) => {
    const page = pdf.addPage([595, 842]);
    let y = 800;
    for (const line of lines) {
      page.drawText(line, { x: 50, y, size: 12, font });
      y -= 40;
    }
    page.drawText(`Page ${i + 1} of ${pages.length}`, { x: 260, y: 30, size: 10, font });
  });
  return Buffer.from(await pdf.save());
}

/** A PDF whose pages have no text layer (like a scan) */
export async function makeScannedPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  page.drawRectangle({ x: 50, y: 50, width: 200, height: 100 });
  return Buffer.from(await pdf.save());
}

export async function makeDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "Sunrise Residency", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: "Rooms", heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ children: [new TextRun("All rooms include free Wi-Fi & air conditioning.")] }),
          new Table({
            rows: [
              new TableRow({
                children: ["Room", "Price per night", "Max guests"].map(
                  (t) => new TableCell({ children: [new Paragraph(t)] }),
                ),
              }),
              new TableRow({
                children: ["Deluxe", "4,500", "2"].map(
                  (t) => new TableCell({ children: [new Paragraph(t)] }),
                ),
              }),
              new TableRow({
                children: ["Suite", "9,000", "4"].map((t) => new TableCell({ children: [new Paragraph(t)] })),
              }),
            ],
          }),
          new Paragraph({ text: "Policies", heading: HeadingLevel.HEADING_2 }),
          new Paragraph("Check-in is from 2 PM. Check-out is until 11 AM."),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

export async function makeXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Projects");
  ws.addRow(["Project", "Location", "Price from", "Possession"]);
  ws.addRow(["Green Heights", "Baner", 8500000, new Date(Date.UTC(2027, 2, 1))]);
  ws.addRow(["Lake View", "Wakad", 6200000, new Date(Date.UTC(2026, 11, 1))]);
  const faq = wb.addWorksheet("FAQ");
  faq.addRow(["Question", "Answer"]);
  faq.addRow(["Is parking included?", "Yes, one covered spot per flat."]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
