import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { exchangeOAuthCode, getSelf, oauthConfig } from "@/lib/canvas";
import { takeOAuthState, writeCanvasSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function back(appUrl: string, result: string): NextResponse {
  return NextResponse.redirect(`${appUrl}/?canvas=${result}`);
}

/** Canvas redirects here after the student approves (or denies) access. */
export async function GET(request: Request): Promise<NextResponse> {
  const config = oauthConfig();
  const appUrl = (process.env.APP_URL?.trim() || new URL(request.url).origin).replace(/\/+$/, "");
  if (!config) return back(appUrl, "unavailable");

  const params = new URL(request.url).searchParams;
  const expected = await takeOAuthState();
  const state = params.get("state") ?? "";
  const code = params.get("code");
  const stateOk =
    expected !== null &&
    expected.length === state.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(state));
  if (params.get("error") || !code) return back(appUrl, "denied");
  if (!stateOk) return back(appUrl, "failed");

  try {
    const session = await exchangeOAuthCode(config, code);
    if (session.userName === "Canvas user") session.userName = (await getSelf(session)).name;
    await writeCanvasSession(session);
    return back(appUrl, "connected");
  } catch {
    return back(appUrl, "failed");
  }
}
