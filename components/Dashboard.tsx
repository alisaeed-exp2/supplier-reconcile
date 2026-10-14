"use client";

import { useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { statusLabel } from "@/lib/engine";
import type { AnnotatedTxn, MatchStatus, ReconResult } from "@/lib/engine";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { cn, money } from "@/lib/utils";

const TONE: Record<MatchStatus, string> = {
  matched: "border-emerald-200 bg-emerald-50 text-emerald-800",
  matched_by_amount: "border-emerald-200 bg-emerald-50 text-emerald-800",
  amount_difference: "border-amber-300 bg-amber-50 text-amber-900",
  probable_match: "border-amber-300 bg-amber-50 text-amber-900",
  missing_in_other: "border-red-200 bg-red-50 text-red-800",
  unmatched_other: "border-red-200 bg-red-50 text-red-800",
};

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "bad" | "good" }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tabular-nums", tone === "bad" && "text-red-700", tone === "good" && "text-emerald-700")}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Dashboard({ result, onExport, exporting }: { result: ReconResult; onExport: () => void; exporting: boolean }) {
  const [side, setSide] = useState<"akcc" | "supplier">("akcc");
  const [filter, setFilter] = useState<"all" | MatchStatus>("all");
  const [q, setQ] = useState("");
  const name = result.supplierName;
  const s = result.summary;
  const c = s.counts;
  const sum = (k: MatchStatus) => c[k].akcc + c[k].supplier;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return result[side].rows.filter(
      (r) => (filter === "all" || r.status === filter) && (!needle || `${r.reference ?? ""} ${r.description} ${r.typeLabel ?? ""}`.toLowerCase().includes(needle)),
    );
  }, [result, side, filter, q]);

  const issues = c.missing_in_other.akcc + c.missing_in_other.supplier + c.amount_difference.akcc + c.unmatched_other.akcc + c.unmatched_other.supplier;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reconciliation result</p>
          <h2 className="text-2xl font-semibold">AKCC vs {name}</h2>
        </div>
        <Button onClick={onExport} disabled={exporting}>
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export to Excel
        </Button>
      </div>

      {s.warnings.map((w, i) => (
        <p key={i} className="rounded-md bg-amber-50 p-2 text-sm text-amber-800">
          {w}
        </p>
      ))}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="AKCC closing (owed to supplier)" value={money(s.akcc.closing)} />
        <Kpi label={`${name} closing`} value={money(s.supplier.closing)} />
        <Kpi label="Difference (supplier − AKCC)" value={money(s.closingDifference)} tone={s.closingDifference ? "bad" : "good"} />
        <Kpi label="Matched" value={String(sum("matched") + sum("matched_by_amount") + sum("probable_match"))} sub={`${c.matched.akcc} invoice pairs`} tone="good" />
        <Kpi label="Items to review" value={String(issues)} sub={`${c.missing_in_other.akcc} missing in ${name} · ${c.missing_in_other.supplier} missing in AKCC`} tone={issues ? "bad" : "good"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Closing balance bridge</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <tbody>
              {s.bridge.map((b) => (
                <tr key={b.key} className="border-b last:border-0">
                  <td className="py-1.5">{b.label.replace("the supplier", name)}</td>
                  <td className="w-16 text-right text-muted-foreground">{b.count || ""}</td>
                  <td className="w-36 text-right tabular-nums">{money(b.amount)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="pt-2">Explained</td>
                <td />
                <td className="pt-2 text-right tabular-nums">{money(s.explained)}</td>
              </tr>
              <tr className="font-semibold">
                <td>Unexplained</td>
                <td />
                <td className={cn("text-right tabular-nums", s.unexplained ? "text-red-700" : "text-emerald-700")}>{money(s.unexplained)}</td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border p-0.5">
              {(["akcc", "supplier"] as const).map((k) => (
                <button key={k} onClick={() => setSide(k)} className={cn("rounded px-3 py-1 text-sm font-medium", side === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
                  {k === "akcc" ? "AKCC Statement" : `${name} Statement`}
                </button>
              ))}
            </div>
            <Select className="w-64" value={filter} onChange={(e) => setFilter(e.target.value as "all" | MatchStatus)}>
              <option value="all">All statuses</option>
              {(Object.keys(c) as MatchStatus[]).map((k) => (
                <option key={k} value={k}>
                  {statusLabel(k, side, name)} ({c[k][side]})
                </option>
              ))}
            </Select>
            <Input className="w-56" placeholder="Search reference / description" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="text-xs text-muted-foreground">{rows.length} rows</span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="max-h-[560px] overflow-auto rounded-md border">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  {["Row", "Date", "Reference", "Description", "Type", "Amount owed", "Status", `${side === "akcc" ? name : "AKCC"} net`, "Difference", "Note"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r: AnnotatedTxn) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-1.5 text-muted-foreground">{r.sourceRow}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{r.date ?? ""}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs">{r.reference ?? "—"}</td>
                    <td className="max-w-[320px] truncate px-3 py-1.5" title={r.description}>
                      {r.description}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 capitalize">{r.typeLabel ?? r.kind.replace("_", " ")}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(r.signed)}</td>
                    <td className="px-3 py-1.5">
                      <Badge className={cn("whitespace-nowrap", TONE[r.status])}>{statusLabel(r.status, side, name)}</Badge>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.counterpartNet === null ? "" : money(r.counterpartNet)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.difference ? money(r.difference) : ""}</td>
                    <td className="max-w-[260px] truncate px-3 py-1.5 text-xs text-muted-foreground" title={r.hint ?? ""}>
                      {r.hint ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
