import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Квота списывается при сохранении расчёта.", code: "calculation_operation_required" },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
