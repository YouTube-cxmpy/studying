import { NextResponse } from "next/server";
import { listCourses } from "@/lib/canvas";
import { canvasErrorResponse, guard, requireCanvas } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const blocked = await guard(request);
  if (blocked) return blocked;
  try {
    const courses = await listCourses(await requireCanvas());
    return NextResponse.json({ courses }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return canvasErrorResponse(err);
  }
}
