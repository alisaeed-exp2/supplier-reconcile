import ExcelJS from "exceljs";
import { statusLabel } from "../engine/match.ts";
import type { AnnotatedTxn, MatchStatus, ReconResult } from "../engine/types.ts";

const FILL: Record<MatchStatus, string> = {
  matched: "FFE2F0D9",
  amount_difference: "FFFFE699",
  missing_in_other: "FFF8CBAD",
  probable_match: "FFFFF2CC",
  matched_by_amount: "FFE2F0D9",
  unmatched_other: "FFF8CBAD",
};

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function addSheet(wb: ExcelJS.Workbook, name: "AKCC Statement" | "Supplier Statement", result: ReconResult, side: "akcc" | "supplier") {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 6 }] });
  const data = result[side];
  const rows: AnnotatedTxn[] = data.rows;
  const s = result.summary;
  const me = side === "akcc" ? s.akcc : s.supplier;
  const other = side === "akcc" ? s.supplier : s.akcc;
  const otherName = side === "akcc" ? result.supplierName : "AKCC";
  const ownName = side === "akcc" ? "AKCC" : result.supplierName;

  // keep only source columns that carry data
  const used = data.headers.map((_, i) => rows.some((r) => r.cells[i] !== null && r.cells[i] !== undefined && String(r.cells[i]).trim() !== ""));
  const srcIdx = data.headers.map((_, i) => i).filter((i) => used[i]);
  const extra = ["Source row", "Document reference", "Type", "Amount owed to supplier (SAR)", "Match status", `${otherName} net (SAR)`, "Difference (SAR)", "Matching row(s)", "Note"];
  const headers = [...srcIdx.map((i) => data.headers[i]), ...extra];

  ws.addRow([`${ownName} Statement | ${result.supplierName} | Reconciliation`]).font = { bold: true, size: 14 };
  ws.addRow(["Red = missing on the other statement  |  Amber = same reference, different net amount  |  Green = matched  |  Positive amounts increase what AKCC owes the supplier"]).font = { italic: true, color: { argb: "FF595959" } };
  ws.addRow([
    `Opening balance: ${fmt(me.opening)}   Closing balance: ${fmt(me.closing)}   ${otherName} closing: ${fmt(other.closing)}   Difference (supplier - AKCC): ${fmt(s.closingDifference)}   Unexplained: ${fmt(s.unexplained)}`,
  ]);
  ws.addRow([`Source file: ${data.fileName}   |   Generated: ${result.generatedAt.slice(0, 16).replace("T", " ")} UTC`]).font = { color: { argb: "FF7F7F7F" } };
  ws.addRow([]);
  const headRow = ws.addRow(headers);
  headRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
  headRow.alignment = { vertical: "middle", wrapText: true };

  for (const r of rows) {
    const row = ws.addRow([
      ...srcIdx.map((i) => r.cells[i]),
      r.sourceRow,
      r.reference ?? "",
      r.typeLabel ?? r.kind.replace("_", " "),
      r.signed,
      statusLabel(r.status, side, result.supplierName),
      r.counterpartNet,
      r.difference,
      r.counterpartRows.join(", "),
      r.hint ?? "",
    ]);
    row.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[r.status] } };
    });
    const base = srcIdx.length;
    for (const k of [base + 4, base + 6, base + 7]) row.getCell(k).numFmt = "#,##0.00;[Red]-#,##0.00";
  }

  const lastDataRow = ws.rowCount;
  ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: Math.max(6, lastDataRow), column: headers.length } };
  headers.forEach((h, i) => {
    ws.getColumn(i + 1).width = /description|name|note|label/i.test(h) ? 46 : h === "Match status" ? 26 : 16;
  });
  ws.getColumn(1).width = Math.max(ws.getColumn(1).width ?? 16, 16);

  // closing balance bridge
  ws.addRow([]);
  const b = ws.addRow(["Reconciliation bridge (supplier closing - AKCC closing)"]);
  b.font = { bold: true };
  for (const item of s.bridge) {
    const row = ws.addRow([item.label.replace("the supplier", result.supplierName), item.count || "", item.amount]);
    row.getCell(3).numFmt = "#,##0.00;[Red]-#,##0.00";
  }
  const t1 = ws.addRow(["Explained difference", "", s.explained]);
  t1.font = { bold: true };
  t1.getCell(3).numFmt = "#,##0.00;[Red]-#,##0.00";
  const t2 = ws.addRow(["Unexplained difference", "", s.unexplained ?? ""]);
  t2.font = { bold: true };
  t2.getCell(3).numFmt = "#,##0.00;[Red]-#,##0.00";
}

/** Produces a workbook with exactly two worksheets: "AKCC Statement" and "Supplier Statement". */
export async function buildReconciliationWorkbook(result: ReconResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AKCC Supplier Reconciliation";
  wb.created = new Date();
  addSheet(wb, "AKCC Statement", result, "akcc");
  addSheet(wb, "Supplier Statement", result, "supplier");
  return Buffer.from(await wb.xlsx.writeBuffer());
}
