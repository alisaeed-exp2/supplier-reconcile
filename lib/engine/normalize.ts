import type { Cell, CellRef, Grid, ParsedStatement, RowMatchRef, StatementProfile, Txn, TxnKind } from "./types.ts";

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function colIndex(letter: string | null | undefined): number {
  if (!letter) return -1;
  const s = letter.trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(s)) return -1;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const cellAt = (row: Cell[] | undefined, letter: string | null | undefined): Cell => {
  const i = colIndex(letter);
  if (!row || i < 0) return null;
  const v = row[i];
  return v === undefined ? null : v;
};

export const cellText = (v: Cell): string => (v === null || v === undefined ? "" : String(v).trim());

/** Parses amounts such as "1,234.50", "(120.00)", "120.00-", "SAR 1 234,50", Arabic-Indic digits. */
export function parseAmount(v: Cell): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/-\s*$/.test(s)) {
    negative = true;
    s = s.replace(/-\s*$/, "");
  }
  if (/^\s*-/.test(s)) {
    negative = !negative;
    s = s.replace(/^\s*-/, "");
  }
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // the later separator is the decimal separator
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // "1,234" -> thousands, "12,5" / "12,50" -> decimal
    const tail = s.length - lastComma - 1;
    s = tail === 3 && s.indexOf(",") === lastComma ? s.replace(",", "") : s.replace(/,/g, ".");
    if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function parseDate(v: Cell, format: "DMY" | "MDY" | "YMD" = "DMY"): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    // Excel serial date
    if (v > 20000 && v < 80000) {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    return null;
  }
  const s = String(v).trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const a = +m[1];
    const b = +m[2];
    if (format === "MDY") return validDate(y, a, b);
    if (format === "YMD") return validDate(y, b, a);
    return validDate(y, b, a); // DMY: a=day, b=month
  }
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ -,]*(\d{2,4})/.exec(s);
  if (m) {
    const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
      m[2].slice(0, 3).toLowerCase(),
    );
    if (mon >= 0) return validDate(+m[3] < 100 ? 2000 + +m[3] : +m[3], mon + 1, +m[1]);
  }
  return null;
}

function validDate(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function safeRegex(pattern: string | null | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export function extractReference(profile: StatementProfile, row: Cell[]): string | null {
  const rule = profile.reference;
  if (!rule) return null;
  const raw = cellAt(row, rule.column);
  let text = typeof raw === "number" && Number.isInteger(raw) ? String(raw) : cellText(raw);
  if (!text) return null;
  const rx = safeRegex(rule.regex);
  if (rx) {
    const m = rx.exec(text);
    if (!m) return null;
    const g = rule.group ?? (m.length > 1 ? 1 : 0);
    text = (m[g] ?? m[0] ?? "").trim();
  }
  return text || null;
}

const KIND_BY_SIGN = (signed: number, hasRef: boolean): TxnKind => {
  if (signed > 0) return "invoice";
  return hasRef ? "credit_note" : "payment";
};

function readBalance(grid: Grid, ref: CellRef | null | undefined, match: RowMatchRef | null | undefined): number | null {
  if (ref) {
    const v = parseAmount(cellAt(grid[ref.row - 1], ref.column));
    if (v !== null) return v;
  }
  if (match) {
    const rx = safeRegex(match.pattern);
    const i = colIndex(match.matchColumn);
    if (rx && i >= 0) {
      for (const row of grid) {
        if (rx.test(cellText(row[i] ?? null))) {
          const v = parseAmount(cellAt(row, match.valueColumn));
          if (v !== null) return v;
        }
      }
    }
  }
  return null;
}

export interface ApplyOptions {
  role: "akcc" | "supplier";
  fileName: string;
  sheetName: string;
}

/** Applies a StatementProfile to a raw grid. Pure and supplier-agnostic. */
export function applyProfile(grid: Grid, profile: StatementProfile, opts: ApplyOptions): ParsedStatement {
  const warnings: string[] = [];
  const cols = profile.columns;
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const headerRow = profile.headerRow ? grid[profile.headerRow - 1] : undefined;
  const headers: string[] = [];
  for (let i = 0; i < width; i++) {
    const h = headerRow ? cellText(headerRow[i] ?? null) : "";
    headers.push(h || `Column ${colLetter(i)}`);
  }

  const skipRules = profile.skipRules.map((r) => ({ i: colIndex(r.column), rx: safeRegex(r.pattern) }));
  const stopRules = profile.stopRules.map((r) => ({ i: colIndex(r.column), rx: safeRegex(r.pattern) }));
  const kindRules = profile.kindRules.map((r) => ({ i: colIndex(r.column), rx: safeRegex(r.pattern), kind: r.kind }));
  const matches = (rules: { i: number; rx: RegExp | null }[], row: Cell[]) =>
    rules.some((r) => r.rx && r.i >= 0 && r.rx.test(cellText(row[r.i] ?? null)));

  const first = Math.max(1, profile.firstDataRow);
  const last = Math.min(grid.length, profile.lastDataRow ?? grid.length);
  const txns: Txn[] = [];
  let skipped = 0;
  const owedOnDebit = profile.owedIncreasesOn === "debit";

  for (let r = first; r <= last; r++) {
    const row = grid[r - 1] ?? [];
    if (row.every((c) => c === null || c === undefined || cellText(c) === "")) continue;
    if (matches(stopRules, row)) break;
    if (matches(skipRules, row)) {
      skipped++;
      continue;
    }

    let debit = 0;
    let credit = 0;
    if (cols.debit || cols.credit) {
      debit = parseAmount(cellAt(row, cols.debit)) ?? 0;
      credit = parseAmount(cellAt(row, cols.credit)) ?? 0;
    } else if (cols.amount) {
      const a = parseAmount(cellAt(row, cols.amount)) ?? 0;
      if (a >= 0) debit = a;
      else credit = -a;
    }
    // a negative figure in a debit/credit column is treated as the opposite side
    if (debit < 0) {
      credit += -debit;
      debit = 0;
    }
    if (credit < 0) {
      debit += -credit;
      credit = 0;
    }
    if (debit === 0 && credit === 0) {
      skipped++;
      continue;
    }

    const signed = round2(owedOnDebit ? debit - credit : credit - debit);
    const reference = extractReference(profile, row);
    const typeLabel = cols.type ? cellText(cellAt(row, cols.type)) || null : null;
    let kind: TxnKind | null = null;
    for (const kr of kindRules) {
      if (kr.rx && kr.i >= 0 && kr.rx.test(cellText(row[kr.i] ?? null))) {
        kind = kr.kind;
        break;
      }
    }
    if (!kind) kind = KIND_BY_SIGN(signed, !!reference);

    txns.push({
      id: `${opts.role}-${r}`,
      sourceRow: r,
      date: parseDate(cellAt(row, cols.date), profile.dateFormat),
      dueDate: parseDate(cellAt(row, cols.dueDate), profile.dateFormat),
      reference,
      description: cellText(cellAt(row, cols.description)),
      typeLabel,
      kind,
      debit: round2(debit),
      credit: round2(credit),
      signed,
      balance: parseAmount(cellAt(row, cols.balance)),
      cells: Array.from({ length: width }, (_, i) => (row[i] === undefined ? null : row[i])),
    });
  }

  // Determine how the running balance relates to "owed to supplier" by testing the deltas.
  const openingRaw = readBalance(grid, profile.openingBalance, profile.openingBalanceMatch);
  let prev: number | null = openingRaw;
  let pos = 0;
  let neg = 0;
  let checked = 0;
  for (const t of txns) {
    if (t.balance !== null && prev !== null) {
      const delta = t.balance - prev;
      if (Math.abs(delta - t.signed) <= 0.011) pos++;
      else if (Math.abs(delta + t.signed) <= 0.011) neg++;
      checked++;
    }
    if (t.balance !== null) prev = t.balance;
  }
  let balanceSign: 1 | -1 | null = null;
  if (pos + neg > 0) balanceSign = pos >= neg ? 1 : -1;
  const breaks = balanceSign === null ? 0 : checked - (balanceSign === 1 ? pos : neg);
  if (balanceSign === null && cols.balance) balanceSign = owedOnDebit ? 1 : -1;
  if (checked > 0 && breaks / checked > 0.2) {
    warnings.push(
      `Running balance does not follow the extracted amounts on ${breaks} of ${checked} rows - check the debit/credit mapping and the "increases amount owed" setting.`,
    );
  }

  const sign = balanceSign ?? 1;
  const openingOwed = openingRaw === null ? null : round2(openingRaw * sign);
  let closingOwed: number | null = null;
  const closingRaw = readBalance(grid, profile.closingBalance, profile.closingBalanceMatch);
  if (closingRaw !== null) closingOwed = round2(closingRaw * sign);
  if (closingOwed === null) {
    const lastBal = [...txns].reverse().find((t) => t.balance !== null)?.balance ?? null;
    if (lastBal !== null) closingOwed = round2(lastBal * sign);
  }

  let supplierName = profile.supplierName?.trim() || null;
  if (!supplierName && profile.supplierNameRule) {
    const rule = profile.supplierNameRule;
    const rowNo = rule.relativeToHeader && profile.headerRow ? profile.headerRow + rule.row : rule.row;
    supplierName = cellText(cellAt(grid[rowNo - 1], rule.column)) || null;
  }

  const totals = txns.reduce(
    (a, t) => ({ debit: round2(a.debit + t.debit), credit: round2(a.credit + t.credit), net: round2(a.net + t.signed) }),
    { debit: 0, credit: 0, net: 0 },
  );
  if (txns.length === 0) warnings.push("No transaction rows were extracted with this profile.");
  if (profile.reference && txns.length > 0 && txns.every((t) => !t.reference)) {
    warnings.push("No document references could be extracted - check the reference column and regex.");
  }

  return {
    role: opts.role,
    fileName: opts.fileName,
    sheetName: opts.sheetName,
    supplierName,
    headers,
    txns,
    openingOwed,
    closingOwed,
    totals,
    balanceCheck: { checked, breaks, balanceSign },
    skippedRows: skipped,
    warnings,
  };
}
