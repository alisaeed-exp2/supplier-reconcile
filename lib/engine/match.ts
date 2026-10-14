import { round2 } from "./normalize.ts";
import type {
  AnnotatedTxn,
  BridgeItem,
  MatchSettings,
  MatchStatus,
  ParsedStatement,
  ReconResult,
  ReconSummary,
  Txn,
} from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

export function referenceKey(ref: string | null, s: MatchSettings): string | null {
  if (!ref) return null;
  let k = ref.trim();
  if (s.caseInsensitive) k = k.toUpperCase();
  if (s.stripNonAlphanumeric) k = k.replace(/[^A-Z0-9]/gi, "");
  if (s.stripLeadingZeros) k = k.replace(/^0+(?=.)/, "");
  return k || null;
}

interface Group {
  key: string;
  rows: AnnotatedTxn[];
  net: number;
}

const STATUSES: MatchStatus[] = [
  "matched",
  "amount_difference",
  "missing_in_other",
  "probable_match",
  "matched_by_amount",
  "unmatched_other",
];

function annotate(t: Txn, s: MatchSettings): AnnotatedTxn {
  return {
    ...t,
    refKey: referenceKey(t.reference, s),
    status: "missing_in_other",
    counterpartNet: null,
    difference: null,
    counterpartRows: [],
    hint: null,
  };
}

function groupByKey(rows: AnnotatedTxn[]): Map<string, Group> {
  const m = new Map<string, Group>();
  for (const r of rows) {
    if (!r.refKey) continue;
    const g = m.get(r.refKey) ?? { key: r.refKey, rows: [], net: 0 };
    g.rows.push(r);
    g.net = round2(g.net + r.signed);
    m.set(r.refKey, g);
  }
  return m;
}

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
}

function link(a: Group, b: Group, status: MatchStatus) {
  const diff = round2(b.net - a.net);
  for (const r of a.rows) {
    r.status = status;
    r.counterpartNet = b.net;
    r.difference = diff;
    r.counterpartRows = b.rows.map((x) => x.sourceRow);
  }
  for (const r of b.rows) {
    r.status = status;
    r.counterpartNet = a.net;
    r.difference = round2(a.net - b.net);
    r.counterpartRows = a.rows.map((x) => x.sourceRow);
  }
}

/**
 * Reusable reconciliation engine. Works on two normalized statements; contains no
 * supplier-specific rules. Passes:
 *  1. exact reference match (netted per reference)
 *  2. optional fuzzy reference match (suffix/containment)
 *  3. non-referenced rows (payments etc.) matched on amount within a date window
 *  4. hints for remaining unmatched rows with an equal amount on the other side
 */
export function reconcile(
  akcc: ParsedStatement,
  supplier: ParsedStatement,
  supplierName: string,
  overrides: Partial<MatchSettings> = {},
): ReconResult {
  const s: MatchSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const A = akcc.txns.map((t) => annotate(t, s));
  const B = supplier.txns.map((t) => annotate(t, s));

  const refRows = (rows: AnnotatedTxn[]) => rows.filter((r) => r.refKey && s.referenceKinds.includes(r.kind));
  const otherRows = (rows: AnnotatedTxn[]) => rows.filter((r) => !(r.refKey && s.referenceKinds.includes(r.kind)));

  const ga = groupByKey(refRows(A));
  const gb = groupByKey(refRows(B));

  // Pass 1: exact
  for (const [key, a] of ga) {
    const b = gb.get(key);
    if (!b) continue;
    link(a, b, Math.abs(a.net - b.net) <= s.amountTolerance ? "matched" : "amount_difference");
  }

  // Pass 2: fuzzy references
  if (s.fuzzyReference) {
    const freeA = [...ga.values()].filter((g) => g.rows[0].counterpartRows.length === 0);
    const freeB = [...gb.values()].filter((g) => g.rows[0].counterpartRows.length === 0);
    const usedB = new Set<string>();
    for (const a of freeA) {
      const cands = freeB.filter(
        (b) =>
          !usedB.has(b.key) &&
          Math.min(a.key.length, b.key.length) >= s.minFuzzyLength &&
          (a.key.endsWith(b.key) || b.key.endsWith(a.key)) &&
          Math.abs(a.net - b.net) <= s.amountTolerance,
      );
      if (cands.length === 1) {
        usedB.add(cands[0].key);
        link(a, cands[0], "probable_match");
      }
    }
  }

  // Pass 3: rows without a usable reference (payments, receipts, adjustments) by amount + date
  const oa = otherRows(A);
  const ob = otherRows(B);
  for (const r of [...oa, ...ob]) r.status = "unmatched_other";
  if (s.matchUnreferencedByAmount) {
    const usedB = new Set<string>();
    for (const a of oa) {
      let best: AnnotatedTxn | null = null;
      let bestDays = Infinity;
      for (const b of ob) {
        if (usedB.has(b.id)) continue;
        if (Math.abs(a.signed - b.signed) > s.amountTolerance) continue;
        const d = daysBetween(a.date, b.date);
        if (d !== null && d > s.dateWindowDays) continue;
        const score = d ?? s.dateWindowDays;
        if (score < bestDays) {
          best = b;
          bestDays = score;
        }
      }
      if (best) {
        usedB.add(best.id);
        a.status = best.status = "matched_by_amount";
        a.counterpartNet = best.signed;
        best.counterpartNet = a.signed;
        a.difference = round2(best.signed - a.signed);
        best.difference = round2(a.signed - best.signed);
        a.counterpartRows = [best.sourceRow];
        best.counterpartRows = [a.sourceRow];
      }
    }
  }

  // Pass 4: hints
  const unmatched = (rows: AnnotatedTxn[]) => rows.filter((r) => r.status === "missing_in_other");
  const ua = unmatched(A);
  const ub = unmatched(B);
  const hint = (from: AnnotatedTxn[], to: AnnotatedTxn[], otherName: string) => {
    for (const r of from) {
      const same = to.filter((x) => Math.abs(x.signed - r.signed) <= s.amountTolerance);
      if (same.length === 1) {
        r.hint = `Same amount as row ${same[0].sourceRow} on ${otherName}${same[0].reference ? ` (ref ${same[0].reference})` : ""} - check for a reference typo`;
      }
    }
  };
  hint(ua, ub, supplierName || "the supplier statement");
  hint(ub, ua, "the AKCC statement");

  return { supplierName, generatedAt: new Date().toISOString(), settings: s, akcc: { fileName: akcc.fileName, headers: akcc.headers, rows: A }, supplier: { fileName: supplier.fileName, headers: supplier.headers, rows: B }, summary: summarize(akcc, supplier, A, B, ga, gb, supplierName) };
}

function summarize(
  akcc: ParsedStatement,
  supplier: ParsedStatement,
  A: AnnotatedTxn[],
  B: AnnotatedTxn[],
  ga: Map<string, Group>,
  gb: Map<string, Group>,
  supplierName: string,
): ReconSummary {
  const counts = Object.fromEntries(STATUSES.map((st) => [st, { akcc: 0, supplier: 0 }])) as ReconSummary["counts"];
  for (const r of A) counts[r.status].akcc++;
  for (const r of B) counts[r.status].supplier++;

  const sum = (rows: AnnotatedTxn[], pred: (r: AnnotatedTxn) => boolean) =>
    round2(rows.filter(pred).reduce((a, r) => a + r.signed, 0));
  const cnt = (rows: AnnotatedTxn[], pred: (r: AnnotatedTxn) => boolean) => rows.filter(pred).length;

  const opening = (st: ParsedStatement) => st.openingOwed;
  const movementA = round2(A.reduce((a, r) => a + r.signed, 0));
  const movementB = round2(B.reduce((a, r) => a + r.signed, 0));
  const openKnown = opening(akcc) !== null && opening(supplier) !== null;
  const closingDifference =
    akcc.closingOwed !== null && supplier.closingOwed !== null ? round2(supplier.closingOwed - akcc.closingOwed) : null;

  const supOnly = (r: AnnotatedTxn) => r.status === "missing_in_other";
  // amount differences / probable matches: counted once per AKCC group
  const d = (() => {
    let total = 0;
    let n = 0;
    for (const g of ga.values()) {
      const st = g.rows[0].status;
      if ((st === "amount_difference" || st === "probable_match") && g.rows[0].counterpartNet !== null) {
        total += g.rows[0].counterpartNet - g.net;
        if (st === "amount_difference") n++;
      }
    }
    return { total: round2(total), n };
  })();

  const bridge: BridgeItem[] = [];
  if (openKnown) {
    bridge.push({ key: "opening", label: "Opening balance difference", amount: round2(opening(supplier)! - opening(akcc)!), count: 0 });
  }
  bridge.push({
    key: "missing_in_akcc",
    label: "Items on the supplier statement but missing in AKCC",
    amount: sum(B, supOnly),
    count: cnt(B, supOnly),
  });
  bridge.push({
    key: "missing_in_supplier",
    label: `Items in AKCC but missing on ${supplierName || "the supplier"} statement`,
    amount: round2(-sum(A, supOnly)),
    count: cnt(A, supOnly),
  });
  bridge.push({ key: "amount_difference", label: "Amount differences on matching references", amount: d.total, count: d.n });
  const unmatchedOther = (r: AnnotatedTxn) => r.status === "unmatched_other";
  bridge.push({
    key: "unmatched_other",
    label: "Unmatched payments / adjustments / non-referenced rows",
    amount: round2(sum(B, unmatchedOther) - sum(A, unmatchedOther)),
    count: cnt(A, unmatchedOther) + cnt(B, unmatchedOther),
  });
  const explained = round2(bridge.reduce((a, b) => a + b.amount, 0));
  const warnings: string[] = [];
  if (!openKnown) warnings.push("Opening balance was not found on one or both statements; the bridge covers period movement only.");
  const unexplained = closingDifference === null ? null : round2(closingDifference - explained);

  // sign-convention sanity check
  if (A.length && B.length && movementA !== 0 && movementB !== 0 && Math.sign(movementA) !== Math.sign(movementB)) {
    warnings.push(
      "Net movement has opposite signs on the two statements. Check the 'increases amount owed' setting for each statement.",
    );
  }

  return {
    counts,
    akcc: { opening: opening(akcc), closing: akcc.closingOwed, movement: movementA },
    supplier: { opening: opening(supplier), closing: supplier.closingOwed, movement: movementB },
    closingDifference,
    bridge,
    explained,
    unexplained,
    warnings,
  };
}

export const STATUS_LABELS: Record<MatchStatus, string> = {
  matched: "Matched",
  amount_difference: "Amount difference",
  missing_in_other: "Missing in other statement",
  probable_match: "Probable match (reference variant)",
  matched_by_amount: "Matched by amount (no reference)",
  unmatched_other: "Unmatched - no reference",
};

/** Human label that names the other party, e.g. "Missing in Acme Foods" / "Missing in AKCC". */
export function statusLabel(status: MatchStatus, side: "akcc" | "supplier", supplierName: string): string {
  if (status === "missing_in_other") return side === "akcc" ? `Missing in ${supplierName || "supplier"}` : "Missing in AKCC";
  return STATUS_LABELS[status];
}
