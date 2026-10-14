import { NextResponse } from "next/server";
import type { ReconResult } from "@/lib/engine";
import { buildReconciliationWorkbook } from "@/lib/server/exportWorkbook";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const result = (await req.json()) as ReconResult;
    if (!result?.akcc?.rows || !result?.supplier?.rows) return NextResponse.json({ error: "Nothing to export." }, { status: 400 });
    const buf = await buildReconciliationWorkbook(result);
    const safe = result.supplierName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "Supplier";
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="AKCC_${safe}_Reconciliation.xlsx"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
