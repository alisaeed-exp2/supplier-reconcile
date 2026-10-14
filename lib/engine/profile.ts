import { colIndex, colLetter, cellText } from "./normalize.ts";
import type { Cell, ColumnMap, Grid, KindRule, SkipRule, StatementProfile, TxnKind } from "./types.ts";

const KINDS: TxnKind[] = ["invoice", "credit_note", "payment", "adjustment", "other"];
const COLUMN_KEYS: (keyof ColumnMap)[] = ["date", "dueDate", "reference", "description", "type", "debit", "credit", "amount", "balance"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const letterOrNull = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return colIndex(s) >= 0 ? s : null;
};
const intOrNull = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
};
const validRegex = (p: unknown): string | null => {
  if (typeof p !== "string" || !p) return null;
  try {
    new RegExp(p, "i");
    return p;
  } catch {
    return null;
  }
};

/** Coerces untrusted JSON (from Claude, a saved file, or the UI) into a safe StatementProfile. */
export function sanitizeProfile(input: unknown): { profile: StatementProfile | null; problems: string[] } {
  const problems: string[] = [];
  if (!isObj(input)) return { profile: null, problems: ["Profile is not an object"] };

  const columns: ColumnMap = {};
  const rawCols = isObj(input.columns) ? input.columns : {};
  for (const k of COLUMN_KEYS) columns[k] = letterOrNull(rawCols[k]);
  if (!columns.debit && !columns.credit && !columns.amount) problems.push("No debit/credit/amount column mapped");

  let reference: StatementProfile["reference"] = null;
  if (isObj(input.reference)) {
    const column = letterOrNull(input.reference.column);
    if (column) {
      const rx = validRegex(input.reference.regex);
      if (input.reference.regex && !rx) problems.push("Reference regex is invalid and was ignored");
      reference = { column, regex: rx, group: intOrNull(input.reference.group) ?? (input.reference.group === 0 ? 0 : null) };
    }
  }
  if (!reference && columns.reference) reference = { column: columns.reference, regex: null, group: null };
  if (!reference) problems.push("No reference column mapped");

  const kindRules: KindRule[] = [];
  if (Array.isArray(input.kindRules)) {
    for (const r of input.kindRules) {
      if (!isObj(r)) continue;
      const column = letterOrNull(r.column);
      const pattern = validRegex(r.pattern);
      const kind = KINDS.includes(r.kind as TxnKind) ? (r.kind as TxnKind) : null;
      if (column && pattern && kind) kindRules.push({ column, pattern, kind });
    }
  }
  const ruleList = (v: unknown): SkipRule[] => {
    const out: SkipRule[] = [];
    if (Array.isArray(v)) {
      for (const r of v) {
        if (!isObj(r)) continue;
        const column = letterOrNull(r.column);
        const pattern = validRegex(r.pattern);
        if (column && pattern) out.push({ column, pattern });
      }
    }
    return out;
  };
  const cellRef = (v: unknown) => {
    if (!isObj(v)) return null;
    const row = intOrNull(v.row);
    const column = letterOrNull(v.column);
    return row && column ? { row, column } : null;
  };

  const rowMatch = (v: unknown) => {
    if (!isObj(v)) return null;
    const matchColumn = letterOrNull(v.matchColumn);
    const valueColumn = letterOrNull(v.valueColumn);
    const pattern = validRegex(v.pattern);
    return matchColumn && valueColumn && pattern ? { matchColumn, valueColumn, pattern } : null;
  };

  const firstDataRow = intOrNull(input.firstDataRow);
  if (!firstDataRow) problems.push("firstDataRow is missing");

  let supplierNameRule: StatementProfile["supplierNameRule"] = null;
  if (isObj(input.supplierNameRule)) {
    const row = typeof input.supplierNameRule.row === "number" ? input.supplierNameRule.row : null;
    const column = letterOrNull(input.supplierNameRule.column);
    if (row !== null && column) supplierNameRule = { row, column, relativeToHeader: !!input.supplierNameRule.relativeToHeader };
  }

  const profile: StatementProfile = {
    version: 1,
    sheetName: typeof input.sheetName === "string" && input.sheetName ? input.sheetName : null,
    supplierName: typeof input.supplierName === "string" && input.supplierName.trim() ? input.supplierName.trim() : null,
    supplierNameRule,
    headerRow: intOrNull(input.headerRow),
    firstDataRow: firstDataRow ?? 1,
    lastDataRow: intOrNull(input.lastDataRow),
    columns,
    reference,
    owedIncreasesOn: input.owedIncreasesOn === "debit" ? "debit" : "credit",
    dateFormat: input.dateFormat === "MDY" || input.dateFormat === "YMD" ? input.dateFormat : "DMY",
    kindRules,
    skipRules: ruleList(input.skipRules),
    stopRules: ruleList(input.stopRules),
    openingBalance: cellRef(input.openingBalance),
    closingBalance: cellRef(input.closingBalance),
    openingBalanceMatch: rowMatch(input.openingBalanceMatch),
    closingBalanceMatch: rowMatch(input.closingBalanceMatch),
    notes: typeof input.notes === "string" ? input.notes : null,
  };
  const fatal = problems.filter((p) => /No debit|firstDataRow/.test(p));
  return { profile: fatal.length ? null : profile, problems };
}

// ---------------------------------------------------------------------------
// Generic, keyword-based fallback when no AI mapping is available.
// ---------------------------------------------------------------------------
const KEYWORDS: Record<string, RegExp> = {
  date: /^(invoice\s*)?(doc(ument)?\s*)?date$|^date$|posting date|trans(action)?\s*date/i,
  dueDate: /due/i,
  reference: /inv(oice)?[\s._-]*(no|num|number|#)|document\s*(no|number)|reference|ref\b|voucher|bill\s*(no|number)/i,
  description: /description|narration|details|particulars|^name$|label/i,
  type: /^type$|trans(action)?\s*type|doc(ument)?\s*type/i,
  debit: /debit|\bdr\b/i,
  credit: /credit|\bcr\b/i,
  amount: /^amount$|net amount/i,
  balance: /balance/i,
};

/** 0-based index of the row that looks most like a column-header row, or null. */
export function detectHeaderRow(grid: Grid): number | null {
  let best = -1;
  let bestScore = 0;
  for (let r = 0; r < Math.min(grid.length, 60); r++) {
    const row = grid[r] ?? [];
    let score = 0;
    for (const c of row) {
      const t = cellText(c);
      if (t && Object.values(KEYWORDS).some((rx) => rx.test(t))) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best >= 0 && bestScore >= 3 ? best : null;
}

/**
 * Stable fingerprint of a statement layout (its column labels), used to reuse a saved
 * profile when the same supplier sends the same format next month.
 */
export function layoutFingerprint(grid: Grid): string {
  const h = detectHeaderRow(grid);
  const labels =
    h !== null
      ? (grid[h] ?? []).map((c) => cellText(c))
      : grid.slice(0, 30).flatMap((r) => r.map((c) => cellText(c))).filter((t) => t && !/\d/.test(t) && t.length < 40);
  const text = labels
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean)
    .sort()
    .join("|");
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${(hash >>> 0).toString(16)}-${text.split("|").length}`;
}

export function heuristicProfile(grid: Grid): StatementProfile | null {
  const best = detectHeaderRow(grid);
  if (best === null) return null;
  const header = grid[best];
  const columns: ColumnMap = {};
  header.forEach((c: Cell, i: number) => {
    const t = cellText(c);
    if (!t) return;
    for (const k of COLUMN_KEYS) {
      if (!columns[k] && KEYWORDS[k].test(t)) {
        columns[k] = colLetter(i);
        break;
      }
    }
  });
  if (!columns.debit && !columns.credit && !columns.amount) return null;
  return {
    version: 1,
    supplierName: null,
    headerRow: best + 1,
    firstDataRow: best + 2,
    lastDataRow: null,
    columns,
    reference: columns.reference ? { column: columns.reference, regex: null, group: null } : columns.description ? { column: columns.description, regex: "([A-Za-z]*[0-9][A-Za-z0-9\\-/]{4,})", group: 1 } : null,
    owedIncreasesOn: "credit",
    dateFormat: "DMY",
    kindRules: [],
    skipRules: [{ column: columns.description ?? columns.reference ?? "A", pattern: "^(total|opening|initial|closing|balance)" }],
    stopRules: [],
    openingBalance: null,
    closingBalance: null,
    notes: "Generated by the keyword fallback (no AI mapping available). Review the mapping.",
  };
}
