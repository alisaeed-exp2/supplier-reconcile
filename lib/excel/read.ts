import * as XLSX from "xlsx";
import type { Cell, Grid } from "../engine/types.ts";

export interface LoadedWorkbook {
  sheetNames: string[];
  grids: Record<string, Grid>;
}

const pad = (n: number) => String(n).padStart(2, "0");

function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    // SheetJS date cells can be a few seconds off; nudge before taking the calendar date.
    const d = new Date(v.getTime() + 30000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  return String(v);
}

/** Reads .xlsx / .xls / .csv into plain grids whose indexes match real sheet rows/columns (A1 = [0][0]). */
export function readWorkbook(buf: Buffer): LoadedWorkbook {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const grids: Record<string, Grid> = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) {
      grids[name] = [];
      continue;
    }
    const range = XLSX.utils.decode_range(ws["!ref"]);
    range.s.r = 0;
    range.s.c = 0;
    ws["!ref"] = XLSX.utils.encode_range(range);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
    const grid = rows.map((r) => r.map(toCell));
    for (const row of grid) while (row.length && row[row.length - 1] === null) row.pop();
    while (grid.length && grid[grid.length - 1].length === 0) grid.pop();
    grids[name] = grid;
  }
  return { sheetNames: wb.SheetNames, grids };
}

/** The sheet most likely to hold the statement: the one with the most numeric cells. */
export function pickSheet(wb: LoadedWorkbook, preferred?: string | null): string {
  if (preferred && wb.grids[preferred]) return preferred;
  let best = wb.sheetNames[0];
  let bestScore = -1;
  for (const name of wb.sheetNames) {
    const score = wb.grids[name].reduce((a, r) => a + r.filter((c) => typeof c === "number").length, 0);
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}
