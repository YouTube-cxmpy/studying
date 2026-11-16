import { NextResponse } from "next/server";
import { getSelf, normalizeBaseUrl } from "@/lib/canvas";
import { canvasErrorResponse, guard, jsonError } from "@/lib/http";
import { type CanvasSession, clearCanvasSession, writeCanvasSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Connect with a personal access token the student generated in Canvas. */
export async function POST(request: Request): Promise<NextResponse> {
  const blocked = await guard(request);
  if (blocked) return blocked;
  const body = (await request.json().catch(() => null)) as
    | { baseUrl?: unknown; token?: unknown; consent?: unknown }
    | null;
  if (typeof body?.baseUrl !== "string" || typeof body.token !== "string" || !body.token.trim()) {
    return jsonError("Enter your Canvas address and access token.", 400);
  }
  if (body.consent !== true) {
    return jsonError("Please confirm you have permission to connect this account.", 400);
  }
  try {
    const session: CanvasSession = {
      baseUrl: await normalizeBaseUrl(body.baseUrl),
      accessToken: body.token.trim(),
      userName: "",
      via: "token",
    };
    // Verifies the token before anything is stored.
    session.userName = (await getSelf(session)).name;
    await writeCanvasSession(session);
    return NextResponse.json({ host: new URL(session.baseUrl).host, userName: session.userName, via: "token" });
  } catch (err) {
    return canvasErrorResponse(err);
  }
}

/** Disconnect: forget the credential. */
export async function DELETE(request: Request): Promise<NextResponse> {
  const blocked = await guard(request);
  if (blocked) return blocked;
  await clearCanvasSession();
  return NextResponse.json({ ok: true });
}
