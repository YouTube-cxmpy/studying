import { NextResponse } from "next/server";
import { guard, jsonError } from "@/lib/http";
import { checkAccessCode, grantAccess } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const blocked = await guard(request, { skipAccess: true });
  if (blocked) return blocked;
  const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
  if (typeof body?.code !== "string" || !checkAccessCode(body.code)) {
    // Slow down guessing a little.
    await new Promise((r) => setTimeout(r, 600));
    return jsonError("That code isn't right.", 401);
  }
  await grantAccess();
  return NextResponse.json({ ok: true });
}
