import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyProfile, reconcile, sanitizeProfile, parseAmount, parseDate, referenceKey, DEFAULT_SETTINGS } from "../lib/engine/index.ts";
import type { Grid } from "../lib/engine/index.ts";

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const akccGrid: Grid = load("./fixtures/akcc-ledger.grid.json");
const soaGrid: Grid = load("./fixtures/sample-soa.grid.json");
const reference = load("./fixtures/reference-statuses.json");
const odoo = sanitizeProfile(load("../profiles/odoo-partner-ledger.json")).profile!;
const supplier = sanitizeProfile(load("./fixtures/sample-supplier-profile.json")).profile!;

const A = applyProfile(akccGrid, odoo, { role: "akcc", fileName: "ledger.xlsx", sheetName: "Partner Ledger" });
const B = applyProfile(soaGrid, supplier, { role: "supplier", fileName: "soa.xls", sheetName: "Statement of Account" });
const R = reconcile(A, B, "Almarai Company");

test("parsers", () => {
  assert.equal(parseAmount("(1,234.50)"), -1234.5);
  assert.equal(parseAmount("1.234,50"), 1234.5);
  assert.equal(parseAmount("120.00-"), -120);
  assert.equal(parseDate("05/09/2026", "DMY"), "2026-09-05");
  assert.equal(parseDate(46266), "2026-09-01");
  assert.equal(referenceKey(" inv-001/a ", DEFAULT_SETTINGS), "INV001A");
});

test("AKCC ledger parsing", () => {
  assert.equal(A.openingOwed, 163532.03);
  assert.equal(A.closingOwed, 149926.21);
  assert.equal(A.balanceCheck.balanceSign, -1);
  assert.equal(A.balanceCheck.breaks, 0);
  assert.equal(A.txns.filter((t) => t.reference).length, 144);
  assert.equal(A.txns.filter((t) => t.kind === "payment").length, 1);
});

test("Supplier statement parsing", () => {
  assert.equal(B.openingOwed, 163946.01);
  assert.equal(B.balanceCheck.balanceSign, 1);
  assert.equal(B.balanceCheck.breaks, 0);
  assert.equal(B.txns.filter((t) => t.kind === "invoice").length, 141);
});

test("statuses agree with the reference reconciliation workbook", () => {
  const expected = (rows: { row: number; status: string }[]) => new Map(rows.map((r) => [r.row, r.status]));
  const ea = expected(reference["AKCC Statement"]);
  const eb = expected(reference["Almarai Statement"]);
  let checked = 0;
  for (const r of R.akcc.rows) {
    const e = ea.get(r.sourceRow);
    if (!e) continue;
    checked++;
    assert.equal(r.status === "matched" ? "Matched" : "Missing", e === "Matched" ? "Matched" : "Missing", `AKCC row ${r.sourceRow}`);
  }
  for (const r of R.supplier.rows) {
    const e = eb.get(r.sourceRow);
    if (!e) continue;
    checked++;
    assert.equal(r.status === "matched" ? "Matched" : "Missing", e === "Matched" ? "Matched" : "Missing", `Supplier row ${r.sourceRow}`);
  }
  assert.equal(checked, 144 + 141);
});

test("payment matched by amount, round-off left unmatched, balance bridge closes", () => {
  assert.equal(R.akcc.rows.find((r) => r.kind === "payment")!.status, "matched_by_amount");
  assert.equal(R.supplier.rows.find((r) => r.kind === "adjustment")!.status, "unmatched_other");
  assert.equal(R.summary.unexplained, 0, JSON.stringify(R.summary, null, 1));
});
