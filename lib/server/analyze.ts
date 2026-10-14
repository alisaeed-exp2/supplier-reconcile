import { applyProfile } from "../engine/normalize.ts";
import { heuristicProfile, layoutFingerprint, sanitizeProfile } from "../engine/profile.ts";
import type { Grid, ParsedStatement, StatementProfile } from "../engine/types.ts";
import { AIUnavailableError, mapStatementWithClaude } from "../ai/mapStatement.ts";
import { previewRows } from "../ai/preview.ts";
import { pickSheet, readWorkbook } from "../excel/read.ts";
import { findPreset } from "./presets.ts";
import { loadProfile, saveProfile } from "./profileStore.ts";

export type ProfileSource = "override" | "saved" | "preset" | "ai" | "heuristic";

export interface AnalyzeInput {
  buf: Buffer;
  fileName: string;
  role: "akcc" | "supplier";
  profileOverride?: unknown;
  sheetName?: string | null;
  /** Persist the resulting profile for reuse. */
  save?: boolean;
}

export interface AnalyzeOutput {
  role: "akcc" | "supplier";
  fingerprint: string;
  source: ProfileSource;
  presetLabel?: string;
  profile: StatementProfile;
  parsed: ParsedStatement;
  sheetNames: string[];
  preview: { row: number; cells: string[] }[];
  messages: string[];
}

function parse(grid: Grid, profile: StatementProfile, input: AnalyzeInput, sheetName: string): ParsedStatement {
  return applyProfile(grid, profile, { role: input.role, fileName: input.fileName, sheetName });
}

/** Parsing is trusted when it yields rows, finds references, and the running balance follows the amounts. */
function problemsWith(p: ParsedStatement, requireRefs: boolean): string[] {
  const out: string[] = [];
  if (p.txns.length === 0) out.push("No transaction rows were extracted.");
  if (requireRefs && p.txns.length > 0 && !p.txns.some((t) => t.reference)) out.push("No document references were extracted.");
  if (p.balanceCheck.checked > 0 && p.balanceCheck.breaks / p.balanceCheck.checked > 0.2) {
    out.push(
      `The running balance disagrees with the extracted amounts on ${p.balanceCheck.breaks} of ${p.balanceCheck.checked} rows (wrong debit/credit columns, wrong owedIncreasesOn, or rows that should be skipped).`,
    );
  }
  return out;
}

export async function analyzeStatement(input: AnalyzeInput): Promise<AnalyzeOutput> {
  const wb = readWorkbook(input.buf);
  if (wb.sheetNames.length === 0) throw new Error("The workbook has no sheets.");
  const sheetName = pickSheet(wb, input.sheetName);
  const grid = wb.grids[sheetName];
  if (!grid || grid.length === 0) throw new Error(`Sheet "${sheetName}" is empty.`);
  const fingerprint = layoutFingerprint(grid);
  const messages: string[] = [];

  const finish = async (profile: StatementProfile, source: ProfileSource, presetLabel?: string): Promise<AnalyzeOutput> => {
    const parsed = parse(grid, profile, input, sheetName);
    if (input.save && source !== "preset") await saveProfile(fingerprint, profile);
    return { role: input.role, fingerprint, source, presetLabel, profile, parsed, sheetNames: wb.sheetNames, preview: previewRows(grid), messages };
  };

  // 1. explicit override from the mapping editor
  if (input.profileOverride) {
    const { profile, problems } = sanitizeProfile(input.profileOverride);
    if (!profile) throw new Error(`Invalid mapping: ${problems.join("; ")}`);
    messages.push(...problems);
    return finish(profile, "override");
  }

  // 2. previously confirmed profile for this layout
  const saved = await loadProfile(fingerprint);
  if (saved) {
    const { profile } = sanitizeProfile(saved);
    if (profile && problemsWith(parse(grid, profile, input, sheetName), false).length === 0) return finish(profile, "saved");
  }

  // 3. configured preset (e.g. the Odoo partner ledger export)
  const preset = findPreset(grid);
  if (preset) {
    const { profile } = sanitizeProfile(preset.profile);
    if (profile && problemsWith(parse(grid, profile, input, sheetName), true).length === 0) return finish(profile, "preset", preset.label);
  }

  // 4. Claude interprets the layout (with one self-correction round driven by engine diagnostics)
  let previous: unknown = null;
  let problems: string[] = [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await mapStatementWithClaude({
        role: input.role,
        fileName: input.fileName,
        sheets: wb.sheetNames.map((n) => ({ name: n, grid: wb.grids[n] })),
        chosenSheet: sheetName,
        feedback: attempt === 0 ? undefined : { previous, problems },
      });
      const { profile, problems: sanitizeProblems } = sanitizeProfile(raw);
      previous = raw;
      if (!profile) {
        problems = sanitizeProblems;
        continue;
      }
      const diag = problemsWith(parse(grid, profile, input, sheetName), true);
      if (diag.length === 0 || attempt === 1) {
        messages.push(...diag.map((d) => `Check the mapping: ${d}`));
        return finish(profile, "ai");
      }
      problems = diag;
    }
  } catch (e) {
    messages.push(e instanceof AIUnavailableError ? `${e.message} Using the keyword fallback - please review the mapping.` : `AI mapping failed (${(e as Error).message}). Using the keyword fallback - please review the mapping.`);
  }

  // 5. keyword fallback
  const h = heuristicProfile(grid);
  if (h) return finish(h, "heuristic");
  throw new Error("Could not work out the statement layout automatically. Check the file and try again.");
}
