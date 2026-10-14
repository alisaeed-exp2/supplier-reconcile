import Anthropic from "@anthropic-ai/sdk";
import type { Grid } from "../engine/types.ts";
import { renderSheetForModel } from "./preview.ts";

export class AIUnavailableError extends Error {}

const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const SYSTEM = `You analyse spreadsheet exports of accounting statements (a company's own vendor ledger, or a supplier's statement of account) and describe how to read them. You never guess numbers and you never copy transactions; you only return a parsing profile by calling the tool.

Definitions
- The reconciliation is about the AMOUNT AKCC OWES THE SUPPLIER. Decide which column, DEBIT or CREDIT, INCREASES that amount on THIS statement ("owedIncreasesOn"). On a customer's own vendor ledger (accounts payable) invoices are normally CREDIT. On a supplier's statement addressed to its customer (accounts receivable view) invoices are normally DEBIT. Judge from the data: the column that holds the many invoice lines increases the amount owed; payments, receipts and credit notes are on the opposite side. If the sheet has one signed amount column, set columns.amount, leave debit/credit empty, and say which sign increases the amount owed through owedIncreasesOn ("debit" = positive increases it).
- Column letters are spreadsheet letters (A, B, ...). Rows are 1-based and match the row numbers shown.
- "reference" is the supplier's document/invoice number that both parties would share. It may be its own column, or embedded in a description cell (then give a regex with one capture group). The regex must tolerate repeated prefixes (e.g. "INV # INV # 123"), must capture only the number, and the captured value must contain a digit. Prefer the supplier's document number over the customer's internal bill number.
- kindRules classify rows by a text column (usually a transaction type or description): invoice, credit_note, payment, adjustment, other. Payments/receipts and round-offs must NOT be classed as invoice. Rules are tested in order, case-insensitive.
- skipRules drop rows inside the data range that are not transactions (opening balance, subtotal, partner header, "Total"). stopRules end the data range at the first matching row (e.g. an ageing table or footer after the transactions).
- Provide openingBalanceMatch / closingBalanceMatch when the sheet has an explicit opening/closing balance row (matchColumn+pattern finds the row, valueColumn is the balance column). Omit them if there is none.
- supplierName: the SUPPLIER's name as printed on the statement (letterhead/title/partner field), cleaned of codes. If the statement is the company's own ledger, use the partner/vendor name it is filtered on. Use null if you cannot find one. Never return the name of the customer AKCC / Al Khalejiah Catering as the supplier.
- dateFormat: DMY, MDY or YMD for text dates. Cells already shown as yyyy-mm-dd are fine with any value.
- If a workbook has several sheets, choose the one with the transactions (sheetName).

Be precise about firstDataRow (first row below the header that can hold a transaction or an opening-balance line), and include a short "notes" explaining anything unusual. Always call the tool exactly once.`;

const TOOL: Anthropic.Tool = {
  name: "submit_statement_profile",
  description: "Return the parsing profile for this statement layout.",
  input_schema: {
    type: "object",
    required: ["supplierName", "headerRow", "firstDataRow", "columns", "reference", "owedIncreasesOn", "dateFormat", "kindRules", "skipRules", "stopRules"],
    properties: {
      sheetName: { type: ["string", "null"] },
      supplierName: { type: ["string", "null"] },
      supplierNameEvidence: { type: ["string", "null"], description: "Where the name was found, e.g. 'cell B1'." },
      headerRow: { type: ["integer", "null"] },
      firstDataRow: { type: "integer" },
      lastDataRow: { type: ["integer", "null"] },
      columns: {
        type: "object",
        properties: Object.fromEntries(
          ["date", "dueDate", "reference", "description", "type", "debit", "credit", "amount", "balance"].map((k) => [k, { type: ["string", "null"], description: "Column letter or null" }]),
        ),
      },
      reference: {
        type: ["object", "null"],
        properties: {
          column: { type: "string" },
          regex: { type: ["string", "null"] },
          group: { type: ["integer", "null"] },
        },
        required: ["column"],
      },
      owedIncreasesOn: { type: "string", enum: ["debit", "credit"] },
      dateFormat: { type: "string", enum: ["DMY", "MDY", "YMD"] },
      kindRules: {
        type: "array",
        items: {
          type: "object",
          required: ["column", "pattern", "kind"],
          properties: {
            column: { type: "string" },
            pattern: { type: "string" },
            kind: { type: "string", enum: ["invoice", "credit_note", "payment", "adjustment", "other"] },
          },
        },
      },
      skipRules: { type: "array", items: { type: "object", required: ["column", "pattern"], properties: { column: { type: "string" }, pattern: { type: "string" } } } },
      stopRules: { type: "array", items: { type: "object", required: ["column", "pattern"], properties: { column: { type: "string" }, pattern: { type: "string" } } } },
      openingBalanceMatch: {
        type: ["object", "null"],
        properties: { matchColumn: { type: "string" }, pattern: { type: "string" }, valueColumn: { type: "string" } },
      },
      closingBalanceMatch: {
        type: ["object", "null"],
        properties: { matchColumn: { type: "string" }, pattern: { type: "string" }, valueColumn: { type: "string" } },
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      notes: { type: ["string", "null"] },
    },
  },
};

export interface MapRequest {
  role: "akcc" | "supplier";
  fileName: string;
  sheets: { name: string; grid: Grid }[];
  chosenSheet: string;
  /** Diagnostics from a previous attempt, so the model can correct itself. */
  feedback?: { previous: unknown; problems: string[] };
}

export async function mapStatementWithClaude(req: MapRequest): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AIUnavailableError("ANTHROPIC_API_KEY is not configured on the server.");
  const client = new Anthropic({ apiKey });

  const others = req.sheets
    .filter((s) => s.name !== req.chosenSheet)
    .map((s) => `--- other sheet "${s.name}" (${s.grid.length} rows) ---\n${renderSheetForModel(s.grid, 8, 0)}`)
    .join("\n");
  const chosen = req.sheets.find((s) => s.name === req.chosenSheet)!;
  const roleText =
    req.role === "akcc"
      ? "This is AKCC's own statement (typically an Odoo 18 Enterprise partner ledger export)."
      : "This is a statement of account issued by a supplier to AKCC.";

  let text = `${roleText}\nFile name: ${req.fileName}\nSheets: ${req.sheets.map((s) => s.name).join(", ")}\n\n--- sheet "${chosen.name}" (${chosen.grid.length} rows; row number | COLUMN=value) ---\n${renderSheetForModel(chosen.grid)}\n${others}`;
  if (req.feedback) {
    text += `\n\nA previous profile was tried and had problems:\n${req.feedback.problems.map((p) => `- ${p}`).join("\n")}\nPrevious profile: ${JSON.stringify(req.feedback.previous)}\nReturn a corrected profile.`;
  }

  // Some models reject a forced tool_choice, so let the model choose and nudge once if it replies in prose.
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: text }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.messages.create({
      model: MODEL(),
      max_tokens: 4000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "auto" },
      messages,
    });
    const block = res.content.find((b) => b.type === "tool_use");
    if (block && block.type === "tool_use") return block.input;
    messages.push({ role: "assistant", content: res.content });
    messages.push({ role: "user", content: `Call the ${TOOL.name} tool now with the parsing profile. Do not reply with text.` });
  }
  throw new Error("The AI did not return a mapping.");
}
