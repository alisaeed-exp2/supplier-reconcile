import Anthropic from "@anthropic-ai/sdk";
import type { Cell, Grid } from "../engine/types.ts";
import { AIUnavailableError } from "./mapStatement.ts";

const MODEL = () => process.env.ANTHROPIC_PDF_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const SYSTEM = `You convert a PDF accounting statement (a vendor ledger or a supplier's statement of account) into a faithful spreadsheet-style table by calling the tool. You copy; you never calculate, correct, merge, reorder or skip.

Rules
- Return every visible row of the statement from top to bottom as an array of cell strings: the title/letterhead lines (supplier name, customer name, statement date, period), the column-header row, EVERY transaction row, opening/closing balance rows, and total rows. Put a text line in its own row (first cell, or in the cell position it visually occupies).
- Keep columns aligned: the same field must be at the same index in every transaction row and the header row. Use an empty string for a blank cell.
- Copy numbers and dates exactly as printed (keep thousands separators, decimals, signs, brackets, trailing minus, dd/mm/yyyy). Do not convert formats.
- If the table header repeats at the top of every page, keep it once only; drop repeated page headers/footers and page numbers.
- If a transaction wraps onto two lines, join it into one row.
- Do not invent rows or values. If something is illegible, leave the cell empty and mention it in "notes".
- Always call the tool exactly once with all rows.`;

const TOOL: Anthropic.Tool = {
  name: "submit_statement_table",
  description: "Return the statement as rows of cells.",
  input_schema: {
    type: "object",
    required: ["rows"],
    properties: {
      rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "All rows, top to bottom." },
      notes: { type: ["string", "null"], description: "Anything illegible, ambiguous or skipped." },
    },
  },
};

export interface PdfExtraction {
  grid: Grid;
  notes: string | null;
}

export async function extractGridFromPdf(buf: Buffer, fileName: string, role: "akcc" | "supplier"): Promise<PdfExtraction> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AIUnavailableError("Reading a PDF needs the AI. ANTHROPIC_API_KEY is not configured on the server.");
  const client = new Anthropic({ apiKey });

  const who = role === "akcc" ? "AKCC's own vendor ledger" : "a supplier's statement of account addressed to AKCC";
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } },
        { type: "text", text: `This PDF (${fileName}) is ${who}. Extract the full statement table by calling ${TOOL.name}.` },
      ],
    },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    // Streaming avoids request timeouts on long statements.
    const stream = client.messages.stream({
      model: MODEL(),
      max_tokens: 32000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "auto" },
      messages,
    });
    const res = await stream.finalMessage();
    const block = res.content.find((b) => b.type === "tool_use");
    if (block && block.type === "tool_use") {
      if (res.stop_reason === "max_tokens") throw new Error("The PDF is too long to extract in one pass. Please upload the statement as an Excel file or split the PDF.");
      const input = block.input as { rows?: unknown; notes?: unknown };
      if (!Array.isArray(input.rows) || input.rows.length === 0) throw new Error("No table could be read from the PDF.");
      const grid: Grid = input.rows.map((r) => (Array.isArray(r) ? r.map((c): Cell => (c === null || c === undefined || String(c).trim() === "" ? null : String(c).trim())) : [null]));
      for (const row of grid) while (row.length && row[row.length - 1] === null) row.pop();
      return { grid, notes: typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : null };
    }
    messages.push({ role: "assistant", content: res.content });
    messages.push({ role: "user", content: `Call the ${TOOL.name} tool now with all rows. Do not reply with text.` });
  }
  throw new Error("The AI could not read a table from the PDF.");
}
