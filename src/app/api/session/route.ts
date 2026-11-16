import { NextResponse } from "next/server";
import { oauthConfig } from "@/lib/canvas";
import { hasAccess, readCanvasSession } from "@/lib/session";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const unlocked = await hasAccess();
  const oauth = oauthConfig();
  const canvas = unlocked ? await readCanvasSession() : null;
  const info: SessionInfo = {
    locked: !unlocked,
    oauthAvailable: oauth !== null,
    oauthHost: oauth ? new URL(oauth.baseUrl).host : undefined,
    canvas: canvas ? { host: new URL(canvas.baseUrl).host, userName: canvas.userName, via: canvas.via } : null,
  };
  return NextResponse.json(info, { headers: { "Cache-Control": "no-store" } });
}
