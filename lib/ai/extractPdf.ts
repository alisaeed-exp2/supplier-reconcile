import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import type { Cell, Grid } from "../engine/types.ts";
import { AIUnavailableError } from "./mapStatement.ts";

const MODEL = () => process.env.ANTHROPIC_PDF_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const PAGES_PER_BATCH = Number(process.env.PDF_PAGES_PER_BATCH) || 3;
const CONCURRENCY = Number(process.env.PDF_CONCURRENCY) || 3;
const MAX_PAGES = 80;
const MAX_TOKENS = 16000;

const SYSTEM = `You convert pages of a PDF accounting statement (a vendor ledger or a supplier's statement of account) into a faithful spreadsheet-style table by calling the tool. You copy; you never calculate, correct, merge, reorder or skip.

Rules
- Return every visible row on the pages you are given, top to bottom, as an array of cell strings: letterhead/title lines (supplier name, customer name, statement date, period), the column-header row, EVERY transaction row, opening/closing balance rows, and total rows. Put a text line in its own row.
- Keep columns aligned: the same field must be at the same index in every transaction row and the header row. Use an empty string for a blank cell. If you are given the column layout of earlier pages, use exactly the same column positions.
- Copy numbers and dates exactly as printed (keep thousands separators, decimals, signs, brackets, trailing minus, dd/mm/yyyy). Do not convert formats.
- Drop page numbers, "Page x of y" and repeated page footers. A repeated column-header row may be returned; it will be removed later.
- If a transaction wraps onto two lines, join it into one row.
- Do not invent rows or values. If something is illegible, leave the cell empty and mention it in "notes".
- Always call the tool exactly once with all rows for the pages you were given.`;

const TOOL: Anthropic.Tool = {
  name: "submit_statement_table",
  description: "Return the rows of the given pages.",
  input_schema: {
    type: "object",
    required: ["rows"],
    properties: {
      rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "All rows on these pages, top to bottom." },
      notes: { type: ["string", "null"], description: "Anything illegible, ambiguous or skipped." },
    },
  },
};

export interface PdfExtraction {
  grid: Grid;
  notes: string | null;
}

interface Chunk {
  rows: string[][];
  notes: string | null;
}

class TooLongError extends Error {}

const norm = (r: (string | null)[]) => r.map((c) => (c ?? "").trim().toLowerCase().replace(/\s+/g, " ")).join("|");

async function sliceDoc(src: PDFDocument, pageIdx: number[]): Promise<string> {
  const doc = await PDFDocument.create();
  const pages = await doc.copyPages(src, pageIdx);
  pages.forEach((p) => doc.addPage(p));
  return Buffer.from(await doc.save()).toString("base64");
}

async function callModel(
  client: Anthropic,
  b64: string,
  fileName: string,
  role: "akcc" | "supplier",
  label: string,
  layoutHint: string | null,
): Promise<Chunk> {
  const who = role === "akcc" ? "AKCC's own vendor ledger" : "a supplier's statement of account addressed to AKCC";
  const hint = layoutHint ? `\n\nColumn layout and first rows of the earlier pages (keep the SAME column positions):\n${layoutHint}` : "";
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
        { type: "text", text: `This PDF excerpt (${fileName}, ${label}) is part of ${who}. Extract all rows on these pages by calling ${TOOL.name}.${hint}` },
      ],
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.messages.stream({ model: MODEL(), max_tokens: MAX_TOKENS, system: SYSTEM, tools: [TOOL], tool_choice: { type: "auto" }, messages }).finalMessage();
    if (res.stop_reason === "max_tokens") throw new TooLongError();
    const block = res.content.find((b) => b.type === "tool_use");
    if (block && block.type === "tool_use") {
      const input = block.input as { rows?: unknown; notes?: unknown };
      const rows = Array.isArray(input.rows) ? input.rows.filter(Array.isArray).map((r) => (r as unknown[]).map((c) => (c === null || c === undefined ? "" : String(c).trim()))) : [];
      return { rows, notes: typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : null };
    }
    messages.push({ role: "assistant", content: res.content });
    messages.push({ role: "user", content: `Call the ${TOOL.name} tool now with all rows. Do not reply with text.` });
  }
  throw new Error("The AI could not read a table from part of the PDF.");
}

/** Extracts a page range; if the answer would not fit, splits the range in half and retries. */
async function extractRange(client: Anthropic, src: PDFDocument, pages: number[], total: number, fileName: string, role: "akcc" | "supplier", hint: string | null): Promise<Chunk> {
  const label = pages.length === 1 ? `page ${pages[0] + 1} of ${total}` : `pages ${pages[0] + 1}-${pages[pages.length - 1] + 1} of ${total}`;
  try {
    return await callModel(client, await sliceDoc(src, pages), fileName, role, label, hint);
  } catch (e) {
    if (!(e instanceof TooLongError)) throw e;
    if (pages.length === 1) throw new Error(`Page ${pages[0] + 1} of the PDF has too many rows to read in one go. Upload this statement as an Excel file instead.`);
    const mid = Math.ceil(pages.length / 2);
    const a = await extractRange(client, src, pages.slice(0, mid), total, fileName, role, hint);
    const b = await extractRange(client, src, pages.slice(mid), total, fileName, role, hint);
    return { rows: [...a.rows, ...b.rows], notes: [a.notes, b.notes].filter(Boolean).join(" ") || null };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function extractGridFromPdf(buf: Buffer, fileName: string, role: "akcc" | "supplier"): Promise<PdfExtraction> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AIUnavailableError("Reading a PDF needs the AI. ANTHROPIC_API_KEY is not configured on the server.");
  const client = new Anthropic({ apiKey });

  let src: PDFDocument;
  try {
    src = await PDFDocument.load(buf, { ignoreEncryption: true });
  } catch {
    throw new Error("This PDF could not be opened. It may be damaged or password-protected.");
  }
  const total = src.getPageCount();
  if (total === 0) throw new Error("The PDF has no pages.");
  if (total > MAX_PAGES) throw new Error(`The PDF has ${total} pages; the limit is ${MAX_PAGES}. Upload it as an Excel file or split the PDF.`);

  const batches: number[][] = [];
  for (let i = 0; i < total; i += PAGES_PER_BATCH) batches.push(Array.from({ length: Math.min(PAGES_PER_BATCH, total - i) }, (_, k) => i + k));

  // First batch alone: it carries the title block and column headers that the later batches align to.
  const first = await extractRange(client, src, batches[0], total, fileName, role, null);
  const headerRow = [...first.rows.slice(0, 40)].sort((a, b) => b.filter(Boolean).length - a.filter(Boolean).length)[0] ?? [];
  const hint = [`Header row: ${JSON.stringify(headerRow)}`, ...first.rows.slice(0, 6).map((r) => JSON.stringify(r))].join("\n");
  const rest = await mapLimit(batches.slice(1), CONCURRENCY, (pages) => extractRange(client, src, pages, total, fileName, role, hint));

  const headerKey = norm(headerRow);
  const rows: string[][] = [...first.rows];
  for (const chunk of rest) for (const r of chunk.rows) if (!headerKey || norm(r) !== headerKey) rows.push(r);

  const grid: Grid = rows.map((r) => {
    const row: Cell[] = r.map((c) => (c === "" ? null : c));
    while (row.length && row[row.length - 1] === null) row.pop();
    return row;
  });
  if (grid.length === 0) throw new Error("No table could be read from the PDF.");
  const notes = [first, ...rest].map((c) => c.notes).filter(Boolean).join(" ") || null;
  return { grid, notes: total > 1 ? `Read ${total} pages in ${batches.length} batches.${notes ? " " + notes : ""}` : notes };
}
