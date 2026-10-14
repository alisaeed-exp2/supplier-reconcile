# AKCC Supplier Reconciliation

Reconciles AKCC's Odoo 18 Enterprise **Partner Ledger** against **any supplier's Statement of Account** (SOA), whatever the supplier's layout. Inputs can be Excel (`.xlsx`, `.xls`), CSV or **PDF**.

## How it works

| Layer | Responsibility |
| --- | --- |
| **Claude (Anthropic API)** | Reads the layout of an unfamiliar statement and returns a *parsing profile* (JSON): header/data rows, column letters, how to extract the document number, which column increases the amount owed, row-type rules, rows to skip, balance rows, and the supplier name. |
| **TypeScript engine** (`lib/engine`) | Applies a profile to the sheet and performs the matching. Deterministic, auditable, dependency-free, and **supplier-agnostic** - no supplier names, invoice formats or column names appear in it. |
| **Profiles** | Plain JSON. Sources, in order: manual mapping > saved layout > preset (`profiles/`, e.g. Odoo) > Claude > keyword fallback. |

Self-checks run on every parse: the running balance must follow the extracted amounts (this also auto-detects the balance sign), and if Claude's profile fails the checks it is asked once to correct itself using the engine's diagnostics.

### PDF statements
A PDF is sent to Claude, which transcribes the statement table into rows (no calculation or correction). The same profile mapping and engine then run on that table, and the running-balance check flags any transcription error. The extracted table is kept in the browser session so editing the mapping does not re-read the PDF. Saved layouts are not used for PDFs.

### Matching passes
1. Exact document reference, netted per reference (matched / amount difference / missing in the other statement).
2. Optional probable matches (one reference contains the other).
3. Payments, receipts and adjustments without a usable reference: matched on amount within a date window.
4. Hints for unmatched rows that have an equal amount on the other side (likely reference typos).

The summary bridges the closing-balance difference (opening difference, items missing on either side, amount differences, unmatched payments/adjustments) and reports any **unexplained** remainder.

### Excel export
Exactly two worksheets: `AKCC Statement` and `Supplier Statement`. Both show the selected supplier name, colour-coded match status, counterpart amounts and the closing-balance bridge.

## Adding a supplier
Nothing to change in code. Upload the statement: Claude maps it, the officer can review/correct the mapping in the UI and tick *Remember this layout*. To ship a fixed profile for a recurring format, add a JSON file under `profiles/` and register it in `lib/server/presets.ts`.

## Configuration
| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required for AI layout mapping. Without it the app falls back to keyword mapping plus manual correction. |
| `ANTHROPIC_MODEL` | Optional, defaults to `claude-sonnet-5-5`. |
| `PROFILE_STORE_DIR` | Optional. Directory for saved layouts; mount a Railway volume here to keep them across deploys. |

## Develop
```bash
npm install
npm run dev        # http://localhost:3000
npm test           # engine tests against the sample AKCC / Almarai files
```
Almarai is used only as a reference sample: `tests/fixtures/` holds the sample grids and a test-only profile mimicking Claude's output.

## Deploy (Railway)
Connect this repository to a Railway service, set `ANTHROPIC_API_KEY`, and deploy. `railway.json` sets the build/start commands and the `/api/health` check.
