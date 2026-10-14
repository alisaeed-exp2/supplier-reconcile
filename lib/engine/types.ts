// Supplier-agnostic domain types. Nothing in lib/engine may reference a specific supplier.

export type Cell = string | number | boolean | null;
export type Grid = Cell[][];

export type TxnKind = "invoice" | "credit_note" | "payment" | "adjustment" | "other";
export type DateFormat = "DMY" | "MDY" | "YMD";

/** Column letters ("A", "B", ... "AA"). */
export interface ColumnMap {
  date?: string | null;
  dueDate?: string | null;
  reference?: string | null;
  description?: string | null;
  type?: string | null;
  debit?: string | null;
  credit?: string | null;
  /** Single signed amount column (alternative to debit/credit). Positive is treated as debit. */
  amount?: string | null;
  balance?: string | null;
}

export interface ReferenceRule {
  /** Column that contains the document/invoice number, or text it is embedded in. */
  column: string;
  /** Optional regex that extracts the number from the cell text. */
  regex?: string | null;
  /** Capture group to use (default 1 when the regex has a group, else the whole match). */
  group?: number | null;
}

export interface KindRule {
  column: string;
  pattern: string; // regex, case-insensitive
  kind: TxnKind;
}

export interface SkipRule {
  column: string;
  pattern: string; // regex, case-insensitive
}

export interface CellRef {
  row: number; // 1-based
  column: string;
}

/** Locates a balance by finding a row whose `matchColumn` matches `pattern`, then reading `valueColumn`. */
export interface RowMatchRef {
  matchColumn: string;
  pattern: string; // regex, case-insensitive
  valueColumn: string;
}

export interface SupplierNameRule {
  /** 1-based row, or a row offset from the header row when `relativeToHeader` is true. */
  row: number;
  column: string;
  relativeToHeader?: boolean;
}

/**
 * A parsing profile describes how to read one statement layout. Profiles are plain JSON,
 * produced by Claude (or a saved/edited profile) and consumed by the generic engine.
 */
export interface StatementProfile {
  version: 1;
  sheetName?: string | null;
  supplierName: string | null;
  supplierNameRule?: SupplierNameRule | null;
  headerRow: number | null; // 1-based
  firstDataRow: number; // 1-based
  lastDataRow?: number | null; // 1-based inclusive, null = until a stop rule or end of sheet
  columns: ColumnMap;
  reference: ReferenceRule | null;
  /** Which side of the statement increases the amount owed to the supplier. */
  owedIncreasesOn: "debit" | "credit";
  dateFormat: DateFormat;
  kindRules: KindRule[];
  skipRules: SkipRule[];
  stopRules: SkipRule[];
  openingBalance?: CellRef | null;
  closingBalance?: CellRef | null;
  /** Dynamic alternative to the absolute cell references above. */
  openingBalanceMatch?: RowMatchRef | null;
  closingBalanceMatch?: RowMatchRef | null;
  notes?: string | null;
}

export interface Txn {
  id: string;
  sourceRow: number; // 1-based row in the source sheet
  date: string | null; // ISO yyyy-mm-dd
  dueDate: string | null;
  reference: string | null;
  description: string;
  typeLabel: string | null;
  kind: TxnKind;
  debit: number;
  credit: number;
  /** Amount owed to the supplier: positive increases the payable, negative reduces it. */
  signed: number;
  balance: number | null;
  /** Original row cells (same width as ParsedStatement.headers). */
  cells: Cell[];
}

export interface ParsedStatement {
  role: "akcc" | "supplier";
  fileName: string;
  sheetName: string;
  supplierName: string | null;
  headers: string[];
  txns: Txn[];
  /** Balances expressed as "owed to supplier" (positive = AKCC owes). */
  openingOwed: number | null;
  closingOwed: number | null;
  totals: { debit: number; credit: number; net: number };
  balanceCheck: { checked: number; breaks: number; balanceSign: 1 | -1 | null };
  skippedRows: number;
  warnings: string[];
}

export interface MatchSettings {
  amountTolerance: number;
  stripNonAlphanumeric: boolean;
  stripLeadingZeros: boolean;
  caseInsensitive: boolean;
  /** Kinds that are matched on reference number. Everything else goes to the amount/date pass. */
  referenceKinds: TxnKind[];
  matchUnreferencedByAmount: boolean;
  dateWindowDays: number;
  /** Allow one reference to match another when one ends with the other (>= minFuzzyLength chars). */
  fuzzyReference: boolean;
  minFuzzyLength: number;
}

export type MatchStatus =
  | "matched"
  | "amount_difference"
  | "missing_in_other"
  | "probable_match"
  | "matched_by_amount"
  | "unmatched_other";

export interface AnnotatedTxn extends Txn {
  refKey: string | null;
  status: MatchStatus;
  /** Net on the other statement for this reference (or the paired row amount). */
  counterpartNet: number | null;
  /** counterpartNet - this net, in "owed to supplier" terms. */
  difference: number | null;
  counterpartRows: number[];
  hint: string | null;
}

export interface BridgeItem {
  key: string;
  label: string;
  amount: number;
  count: number;
}

export interface ReconSummary {
  counts: Record<MatchStatus, { akcc: number; supplier: number }>;
  akcc: { opening: number | null; closing: number | null; movement: number };
  supplier: { opening: number | null; closing: number | null; movement: number };
  /** supplier closing - AKCC closing (owed terms). */
  closingDifference: number | null;
  bridge: BridgeItem[];
  explained: number;
  unexplained: number | null;
  warnings: string[];
}

export interface ReconResult {
  supplierName: string;
  generatedAt: string;
  settings: MatchSettings;
  akcc: { fileName: string; headers: string[]; rows: AnnotatedTxn[] };
  supplier: { fileName: string; headers: string[]; rows: AnnotatedTxn[] };
  summary: ReconSummary;
}

export const DEFAULT_SETTINGS: MatchSettings = {
  amountTolerance: 0.01,
  stripNonAlphanumeric: true,
  stripLeadingZeros: false,
  caseInsensitive: true,
  referenceKinds: ["invoice", "credit_note"],
  matchUnreferencedByAmount: true,
  dateWindowDays: 10,
  fuzzyReference: false,
  minFuzzyLength: 6,
};
