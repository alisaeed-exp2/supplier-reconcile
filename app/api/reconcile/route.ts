import { NextResponse } from "next/server";
import { reconcile } from "@/lib/engine";
import type { MatchSettings, ParsedStatement } from "@/lib/engine";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      akcc: ParsedStatement;
      supplier: ParsedStatement;
      supplierName: string;
      settings?: Partial<MatchSettings>;
    };
    if (!body?.akcc?.txns || !body?.supplier?.txns) return NextResponse.json({ error: "Both statements are required." }, { status: 400 });
    const name = (body.supplierName || body.supplier.supplierName || body.akcc.supplierName || "Supplier").trim();
    return NextResponse.json(reconcile(body.akcc, body.supplier, name, body.settings ?? {}));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
}
