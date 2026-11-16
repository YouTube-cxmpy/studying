import { NextResponse } from "next/server";
import { getCourseOverview } from "@/lib/canvas";
import { canvasErrorResponse, guard, requireCanvas } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
): Promise<NextResponse> {
  const blocked = await guard(request);
  if (blocked) return blocked;
  try {
    const { courseId } = await context.params;
    const overview = await getCourseOverview(await requireCanvas(), courseId);
    return NextResponse.json(overview, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return canvasErrorResponse(err);
  }
}
