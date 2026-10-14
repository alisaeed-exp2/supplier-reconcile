import odooPartnerLedger from "../../profiles/odoo-partner-ledger.json";
import { cellText } from "../engine/normalize.ts";
import type { Grid } from "../engine/types.ts";

export interface Preset {
  id: string;
  label: string;
  /** Header labels that must all appear in one row for the preset to apply. */
  requiredHeaders: string[];
  profile: unknown;
}

/** Configurable parsing presets. Add new JSON profiles here; no engine change needed. */
export const PRESETS: Preset[] = [
  {
    id: "odoo-partner-ledger",
    label: "Odoo 18 Partner Ledger",
    requiredHeaders: ["journal", "account", "debit", "credit", "balance"],
    profile: odooPartnerLedger,
  },
];

export function findPreset(grid: Grid): Preset | null {
  for (const preset of PRESETS) {
    const ok = grid.slice(0, 15).some((row) => {
      const labels = row.map((c) => cellText(c).toLowerCase());
      return preset.requiredHeaders.every((h) => labels.includes(h));
    });
    if (ok) return preset;
  }
  return null;
}
