import { NextResponse } from "next/server";
import { CanvasError, ensureFresh } from "./canvas";
import { type CanvasSession, hasAccess, readCanvasSession } from "./session";

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Gate for every API route: the optional access code, plus a same-origin check
 * on state-changing requests so another site can't drive a student's session.
 */
export async function guard(request: Request, opts: { skipAccess?: boolean } = {}): Promise<NextResponse | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (origin && host && new URL(origin).host !== host) {
      return jsonError("Cross-site requests aren't allowed.", 403);
    }
  }
  if (!opts.skipAccess && !(await hasAccess())) {
    return jsonError("Enter the access code to use this app.", 401);
  }
  return null;
}

export async function requireCanvas(): Promise<CanvasSession> {
  const session = await readCanvasSession();
  if (!session) throw new CanvasError("Connect your Canvas account first.", 401);
  return ensureFresh(session);
}

export function canvasErrorResponse(err: unknown): NextResponse {
  if (err instanceof CanvasError) return jsonError(err.message, err.status >= 400 && err.status < 600 ? err.status : 502);
  // Say what actually happened so the problem can be found and fixed.
  const detail = err instanceof Error ? err.message : String(err);
  console.error("[canvas]", err);
  return jsonError(`Something went wrong on our side while talking to Canvas (${detail.slice(0, 200)}).`, 500);
}
