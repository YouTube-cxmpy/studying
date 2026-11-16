import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { oauthConfig } from "@/lib/canvas";
import { jsonError } from "@/lib/http";
import { hasAccess, writeOAuthState } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Sends the student to their school's Canvas to approve access. */
export async function GET(): Promise<NextResponse> {
  if (!(await hasAccess())) return jsonError("Enter the access code to use this app.", 401);
  const config = oauthConfig();
  if (!config) return jsonError("Canvas sign-in isn't configured on this server.", 404);
  const state = crypto.randomBytes(24).toString("base64url");
  await writeOAuthState(state);
  const url = new URL("/login/oauth2/auth", config.baseUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  if (config.scopes) url.searchParams.set("scope", config.scopes);
  return NextResponse.redirect(url);
}
