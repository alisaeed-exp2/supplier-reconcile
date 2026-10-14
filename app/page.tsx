"use client";

import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet, Loader2, Scale } from "lucide-react";
import type { AnalyzeOutput } from "@/lib/server/analyze";
import { DEFAULT_SETTINGS } from "@/lib/engine";
import type { MatchSettings, ReconResult, StatementProfile } from "@/lib/engine";
import { Dashboard } from "@/components/Dashboard";
import { StatementCard } from "@/components/StatementCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

type Role = "akcc" | "supplier";
interface Slot {
  file: File | null;
  loading: boolean;
  error: string | null;
  analysis: AnalyzeOutput | null;
}
const empty: Slot = { file: null, loading: false, error: null, analysis: null };

export default function Page() {
  const [akcc, setAkcc] = useState<Slot>(empty);
  const [sup, setSup] = useState<Slot>(empty);
  const [supplierName, setSupplierName] = useState("");
  const nameTouched = useRef(false);
  const [settings, setSettings] = useState<MatchSettings>(DEFAULT_SETTINGS);
  const [result, setResult] = useState<ReconResult | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setSlot = (role: Role, patch: Partial<Slot>) => (role === "akcc" ? setAkcc : setSup)((s) => ({ ...s, ...patch }));

  // Suggest the supplier name from the statements unless the officer typed one.
  useEffect(() => {
    if (nameTouched.current) return;
    const suggested = sup.analysis?.parsed.supplierName || akcc.analysis?.parsed.supplierName || "";
    if (suggested) setSupplierName(suggested);
  }, [akcc.analysis, sup.analysis]);

  async function analyze(role: Role, file: File, profile?: StatementProfile, save = false, grid?: unknown) {
    setSlot(role, { file, loading: true, error: null });
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("role", role);
      if (profile) {
        fd.append("profile", JSON.stringify(profile));
        fd.append("save", String(save));
        if (grid) fd.append("grid", JSON.stringify(grid));
      }
      const res = await fetch("/api/analyze", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not read the file.");
      setSlot(role, { analysis: data as AnalyzeOutput, loading: false });
    } catch (e) {
      setSlot(role, { loading: false, error: (e as Error).message, analysis: null });
    }
  }

  async function runReconcile() {
    if (!akcc.analysis || !sup.analysis) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ akcc: akcc.analysis.parsed, supplier: sup.analysis.parsed, supplierName: supplierName.trim(), settings }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Reconciliation failed.");
      setResult(data as ReconResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function exportXlsx() {
    if (!result) return;
    setExporting(true);
    try {
      const res = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) });
      if (!res.ok) throw new Error((await res.json()).error || "Export failed.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = /filename="(.+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "Reconciliation.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  const ready = !!akcc.analysis && !!sup.analysis && !akcc.loading && !sup.loading;
  const set = <K extends keyof MatchSettings>(k: K, v: MatchSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary p-2 text-primary-foreground">
            <Scale className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold leading-tight">AKCC Supplier Reconciliation</h1>
            <p className="text-sm text-muted-foreground">Odoo partner ledger vs any supplier statement of account</p>
          </div>
        </div>
        {supplierName && (
          <div className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm shadow-sm">
            <FileSpreadsheet className="h-4 w-4 text-primary" />
            <span className="text-muted-foreground">Supplier</span>
            <span className="font-semibold">{supplierName}</span>
          </div>
        )}
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <StatementCard
          role="akcc"
          title="1. AKCC statement"
          description="Partner ledger exported from Odoo 18 Enterprise (Excel or PDF)."
          {...akcc}
          onFile={(f) => analyze("akcc", f)}
          onRemap={(p, save) => akcc.file && analyze("akcc", akcc.file, p, save, akcc.analysis?.sourceGrid)}
        />
        <StatementCard
          role="supplier"
          title="2. Supplier statement"
          description="The supplier's statement of account: Excel in any layout, or a PDF."
          {...sup}
          onFile={(f) => analyze("supplier", f)}
          onRemap={(p, save) => sup.file && analyze("supplier", sup.file, p, save, sup.analysis?.sourceGrid)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>3. Supplier and matching options</CardTitle>
          <CardDescription>The supplier name is detected from the statements. Correct it if needed; it is used in the dashboard and the exported report.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="md:col-span-2">
              <Label>Supplier name</Label>
              <Input
                value={supplierName}
                placeholder="Detected automatically, or type the supplier name"
                onChange={(e) => {
                  nameTouched.current = true;
                  setSupplierName(e.target.value);
                }}
              />
            </div>
            <div>
              <Label>Amount tolerance (SAR)</Label>
              <Input type="number" step="0.01" min="0" value={settings.amountTolerance} onChange={(e) => set("amountTolerance", Math.max(0, Number(e.target.value) || 0))} />
            </div>
            <div>
              <Label>Payment date window (days)</Label>
              <Input type="number" min="0" value={settings.dateWindowDays} onChange={(e) => set("dateWindowDays", Math.max(0, Number(e.target.value) || 0))} />
            </div>
          </div>
          <div className="flex flex-wrap gap-5 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.stripLeadingZeros} onChange={(e) => set("stripLeadingZeros", e.target.checked)} /> Ignore leading zeros in references
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.fuzzyReference} onChange={(e) => set("fuzzyReference", e.target.checked)} /> Suggest probable matches when one reference contains the other
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.matchUnreferencedByAmount} onChange={(e) => set("matchUnreferencedByAmount", e.target.checked)} /> Match payments without a reference by amount and date
            </label>
          </div>
          {error && <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p>}
          <Button size="lg" onClick={runReconcile} disabled={!ready || running}>
            {running && <Loader2 className="h-4 w-4 animate-spin" />} {result ? "Re-run reconciliation" : "Reconcile"}
          </Button>
        </CardContent>
      </Card>

      {result && <Dashboard result={result} onExport={exportXlsx} exporting={exporting} />}
    </main>
  );
}
