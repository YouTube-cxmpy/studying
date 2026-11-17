import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cookies, headers } from "next/headers";

// Encrypted, httpOnly cookies. Nothing about a student is stored on the server:
// the Canvas credential lives only in the student's own browser cookie, sealed
// with AES-256-GCM so neither page scripts nor other sites can read it.

const CANVAS_COOKIE = "sk_canvas";
const ACCESS_COOKIE = "sk_access";
const OAUTH_STATE_COOKIE = "sk_oauth_state";
const MAX_AGE = 60 * 60 * 24 * 30;

export interface CanvasSession {
  baseUrl: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Only set for OAuth tokens. */
  expiresAt?: number;
  userName: string;
  via: "token" | "oauth";
}

let cachedKey: Buffer | null = null;

function secretKey(): Buffer {
  if (cachedKey) return cachedKey;
  // SESSION_SECRET is best. Without it, fall back to something stable on this
  // server so sign-in still works instead of failing: the API key (never sent to
  // the browser), then a secret file, then a per-process secret.
  let secret = process.env.SESSION_SECRET?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (!secret) {
    const file = path.join(process.cwd(), ".data", "dev-session-secret");
    try {
      secret = fs.readFileSync(file, "utf8").trim();
    } catch {
      secret = crypto.randomBytes(32).toString("hex");
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, secret, { mode: 0o600 });
      } catch {
        // Read-only disk: the secret lasts until the server restarts.
      }
    }
  }
  cachedKey = crypto.createHash("sha256").update(`studykit-session:${secret}`).digest();
  return cachedKey;
}

export function seal(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function unseal<T>(sealed: string | undefined): T | null {
  if (!sealed) return null;
  try {
    const raw = Buffer.from(sealed, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const body = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Browsers drop `Secure` cookies on plain http, so only mark them secure when the site is served over https. */
async function cookieOptions(maxAge: number) {
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const https = proto ? proto === "https" : (process.env.APP_URL ?? "").startsWith("https://");
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: https,
    path: "/",
    maxAge,
  };
}

export async function readCanvasSession(): Promise<CanvasSession | null> {
  const jar = await cookies();
  return unseal<CanvasSession>(jar.get(CANVAS_COOKIE)?.value);
}

export async function writeCanvasSession(session: CanvasSession): Promise<void> {
  const jar = await cookies();
  jar.set(CANVAS_COOKIE, seal(session), await cookieOptions(MAX_AGE));
}

export async function clearCanvasSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(CANVAS_COOKIE);
}

export async function writeOAuthState(state: string): Promise<void> {
  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, seal({ state }), await cookieOptions(600));
}

export async function takeOAuthState(): Promise<string | null> {
  const jar = await cookies();
  const value = unseal<{ state: string }>(jar.get(OAUTH_STATE_COOKIE)?.value);
  jar.delete(OAUTH_STATE_COOKIE);
  return value?.state ?? null;
}

// ---- Optional access code -------------------------------------------------

export function accessCodeRequired(): boolean {
  return Boolean(process.env.APP_ACCESS_CODE?.trim());
}

export function checkAccessCode(candidate: string): boolean {
  const expected = process.env.APP_ACCESS_CODE?.trim() ?? "";
  const a = crypto.createHash("sha256").update(candidate.trim()).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return expected.length > 0 && crypto.timingSafeEqual(a, b);
}

export async function grantAccess(): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, seal({ ok: true }), await cookieOptions(MAX_AGE));
}

export async function hasAccess(): Promise<boolean> {
  if (!accessCodeRequired()) return true;
  const jar = await cookies();
  return unseal<{ ok: boolean }>(jar.get(ACCESS_COOKIE)?.value)?.ok === true;
}
