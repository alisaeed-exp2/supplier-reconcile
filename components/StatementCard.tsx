"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Sparkles, Upload } from "lucide-react";
import type { AnalyzeOutput } from "@/lib/server/analyze";
import type { StatementProfile } from "@/lib/engine";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { money } from "@/lib/utils";

const SOURCE_LABEL: Record<AnalyzeOutput["source"], string> = {
  override: "Manual mapping",
  saved: "Saved layout",
  preset: "Preset",
  ai: "Claude AI mapping",
  heuristic: "Keyword fallback",
};

const COLS = [
  ["date", "Date"],
  ["dueDate", "Due date"],
  ["description", "Description"],
  ["type", "Type"],
  ["debit", "Debit"],
  ["credit", "Credit"],
  ["amount", "Signed amount"],
  ["balance", "Balance"],
] as const;

interface Props {
  title: string;
  description: string;
  role: "akcc" | "supplier";
  file: File | null;
  loading: boolean;
  error: string | null;
  analysis: AnalyzeOutput | null;
  onFile: (f: File) => void;
  onRemap: (profile: StatementProfile, save: boolean) => void;
}

export function StatementCard({ title, description, role, file, loading, error, analysis, onFile, onRemap }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<StatementProfile | null>(null);
  const [rulesText, setRulesText] = useState("");
  const [save, setSave] = useState(true);
  const [dragging, setDragging] = useState(false);

  const profile = draft ?? analysis?.profile ?? null;
  const p = analysis?.parsed;

  const edit = (patch: Partial<StatementProfile>) => profile && setDraft({ ...profile, ...patch });
  const editCol = (k: string, v: string) => profile && setDraft({ ...profile, columns: { ...profile.columns, [k]: v.trim().toUpperCase() || null } });

  const openEditor = () => {
    if (!open && analysis) {
      setDraft(analysis.profile);
      const { kindRules, skipRules, stopRules, openingBalanceMatch, closingBalanceMatch } = analysis.profile;
      setRulesText(JSON.stringify({ kindRules, skipRules, stopRules, openingBalanceMatch, closingBalanceMatch }, null, 2));
    }
    setOpen(!open);
  };

  const apply = () => {
    if (!profile) return;
    let rules = {};
    try {
      rules = rulesText ? JSON.parse(rulesText) : {};
    } catch {
      alert("The advanced rules are not valid JSON.");
      return;
    }
    onRemap({ ...profile, ...rules }, save);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title}
          {analysis && (
            <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">
              <CheckCircle2 className="mr-1 h-3 w-3" /> read
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) onFile(f);
          }}
          className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed px-4 py-6 text-center text-sm transition-colors ${dragging ? "border-primary bg-secondary" : "border-input hover:bg-muted"}`}
        >
          {loading ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : <Upload className="h-5 w-5 text-muted-foreground" />}
          <span className="font-medium">{file ? file.name : "Drop an Excel or PDF file here or click to browse"}</span>
          <span className="text-xs text-muted-foreground">Excel (.xlsx, .xls), CSV or PDF</span>
          <input
            type="file"
            accept=".xlsx,.xlsm,.xls,.csv,.pdf,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = "";
            }}
          />
        </label>

        {loading && (
          <p className="text-xs text-muted-foreground">
            {file && /\.pdf$/i.test(file.name) ? "Claude is reading the PDF - this can take a minute or two for long statements…" : role === "supplier" ? "Claude is reading the statement layout…" : "Reading the statement…"}
          </p>
        )}
        {error && <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p>}

        {analysis && p && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="border-blue-200 bg-blue-50 text-blue-800">
                <Sparkles className="mr-1 h-3 w-3" />
                {SOURCE_LABEL[analysis.source]}
                {analysis.presetLabel ? `: ${analysis.presetLabel}` : ""}
              </Badge>
              <span className="text-muted-foreground">
                {p.txns.length} rows · sheet “{p.sheetName}”
                {p.skippedRows > 0 ? ` · ${p.skippedRows} non-transaction rows skipped` : ""}
              </span>
            </div>
            <dl className="grid grid-cols-3 gap-2 rounded-md bg-muted p-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Opening (owed)</dt>
                <dd className="font-medium">{money(p.openingOwed)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Movement</dt>
                <dd className="font-medium">{money(p.totals.net)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Closing (owed)</dt>
                <dd className="font-medium">{money(p.closingOwed)}</dd>
              </div>
            </dl>
            {[...analysis.messages, ...p.warnings].map((m, i) => (
              <p key={i} className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                {m}
              </p>
            ))}

            <button type="button" onClick={openEditor} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Review / correct the column mapping
            </button>

            {open && profile && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <Label>Header row</Label>
                    <Input type="number" value={profile.headerRow ?? ""} onChange={(e) => edit({ headerRow: e.target.value ? Number(e.target.value) : null })} />
                  </div>
                  <div>
                    <Label>First data row</Label>
                    <Input type="number" value={profile.firstDataRow} onChange={(e) => edit({ firstDataRow: Number(e.target.value) || 1 })} />
                  </div>
                  <div>
                    <Label>Last data row</Label>
                    <Input type="number" placeholder="auto" value={profile.lastDataRow ?? ""} onChange={(e) => edit({ lastDataRow: e.target.value ? Number(e.target.value) : null })} />
                  </div>
                  <div>
                    <Label>Increases amount owed</Label>
                    <Select value={profile.owedIncreasesOn} onChange={(e) => edit({ owedIncreasesOn: e.target.value as "debit" | "credit" })}>
                      <option value="credit">Credit column</option>
                      <option value="debit">Debit column</option>
                    </Select>
                  </div>
                  <div>
                    <Label>Date format</Label>
                    <Select value={profile.dateFormat} onChange={(e) => edit({ dateFormat: e.target.value as StatementProfile["dateFormat"] })}>
                      <option value="DMY">DD/MM/YYYY</option>
                      <option value="MDY">MM/DD/YYYY</option>
                      <option value="YMD">YYYY/MM/DD</option>
                    </Select>
                  </div>
                  <div>
                    <Label>Reference column</Label>
                    <Input
                      value={profile.reference?.column ?? ""}
                      onChange={(e) => edit({ reference: { column: e.target.value.trim().toUpperCase(), regex: profile.reference?.regex ?? null, group: profile.reference?.group ?? null } })}
                    />
                  </div>
                  <div className="col-span-3">
                    <Label>Reference regex (optional, one capture group)</Label>
                    <Input
                      className="font-mono text-xs"
                      value={profile.reference?.regex ?? ""}
                      onChange={(e) => edit({ reference: { column: profile.reference?.column ?? "A", regex: e.target.value || null, group: profile.reference?.group ?? null } })}
                    />
                  </div>
                  {COLS.map(([k, label]) => (
                    <div key={k}>
                      <Label>{label} column</Label>
                      <Input value={(profile.columns as Record<string, string | null | undefined>)[k] ?? ""} onChange={(e) => editCol(k, e.target.value)} maxLength={3} />
                    </div>
                  ))}
                </div>
                <div>
                  <Label>Advanced rules (JSON): row types, rows to skip, stop rows, balance rows</Label>
                  <textarea className="h-32 w-full rounded-md border border-input bg-card p-2 font-mono text-xs" value={rulesText} onChange={(e) => setRulesText(e.target.value)} />
                </div>
                <div className="overflow-auto rounded-md border text-[11px]" style={{ maxHeight: 200 }}>
                  <table className="min-w-full">
                    <tbody>
                      {analysis.preview.slice(0, 30).map((r) => (
                        <tr key={r.row} className={r.row === profile.headerRow ? "bg-blue-50 font-semibold" : r.row === profile.firstDataRow ? "bg-emerald-50" : ""}>
                          <td className="sticky left-0 bg-muted px-1 text-muted-foreground">{r.row}</td>
                          {r.cells.map((c, i) => (
                            <td key={i} className="whitespace-nowrap px-1.5 py-0.5">
                              {c}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Remember this layout for future statements
                  </label>
                  <Button size="sm" onClick={apply} disabled={loading}>
                    Apply mapping
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
