import { colLetter, cellText } from "../engine/normalize.ts";
import type { Grid } from "../engine/types.ts";

const clip = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function renderRows(grid: Grid, from: number, to: number): string {
  const lines: string[] = [];
  for (let r = from; r < Math.min(to, grid.length); r++) {
    const cells = (grid[r] ?? []).map((c, i) => (cellText(c) ? `${colLetter(i)}=${clip(cellText(c))}` : null)).filter(Boolean);
    lines.push(`${String(r + 1).padStart(4)} | ${cells.join(" | ") || "(empty)"}`);
  }
  return lines.join("\n");
}

/** Compact, row-numbered text view of a sheet for the model: head + tail, columns labelled by letter. */
export function renderSheetForModel(grid: Grid, head = 45, tail = 25): string {
  if (grid.length <= head + tail) return renderRows(grid, 0, grid.length);
  return [renderRows(grid, 0, head), `   ... (${grid.length - head - tail} rows omitted) ...`, renderRows(grid, grid.length - tail, grid.length)].join("\n");
}

/** Rows for the UI mapping editor. */
export function previewRows(grid: Grid, max = 40): { row: number; cells: string[] }[] {
  return grid.slice(0, max).map((r, i) => ({ row: i + 1, cells: r.map((c) => clip(cellText(c), 40)) }));
}
