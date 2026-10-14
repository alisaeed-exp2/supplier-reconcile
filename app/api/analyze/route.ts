import { NextResponse } from "next/server";
import { analyzeStatement } from "@/lib/server/analyze";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const role = form.get("role");
    if (!(file instanceof File)) return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    if (role !== "akcc" && role !== "supplier") return NextResponse.json({ error: "Invalid role." }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: "File is larger than 15 MB." }, { status: 413 });

    if (!/\.(xlsx|xlsm|xls|csv|pdf)$/i.test(file.name)) return NextResponse.json({ error: "Upload an Excel (.xlsx, .xls), CSV or PDF file." }, { status: 400 });

    const overrideText = form.get("profile");
    const gridText = form.get("grid");
    const out = await analyzeStatement({
      buf: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      role,
      profileOverride: typeof overrideText === "string" && overrideText ? JSON.parse(overrideText) : undefined,
      gridOverride: typeof gridText === "string" && gridText ? JSON.parse(gridText) : null,
      sheetName: (form.get("sheetName") as string) || null,
      save: form.get("save") === "true",
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Could not read the statement." }, { status: 422 });
  }
}
