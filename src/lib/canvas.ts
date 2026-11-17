import dns from "node:dns/promises";
import net from "node:net";
import { convert } from "html-to-text";
import type {
  CanvasAssignment,
  CanvasCourse,
  CanvasCourseOverview,
  CanvasMaterial,
} from "./types";
import { type CanvasSession, writeCanvasSession } from "./session";
import { isSupportedFileName } from "./extract";

// Read-only client for the Canvas LMS REST API. Every call here is a GET; the
// only POSTs are the OAuth token exchange and refresh.

export class CanvasError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

// ---- URL safety -----------------------------------------------------------
// The Canvas address comes from the user, so the server must not be talked
// into fetching internal addresses on their behalf.

function insecureDevHosts(): string[] {
  if (process.env.NODE_ENV === "production") return [];
  return (process.env.CANVAS_ALLOW_INSECURE_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CanvasError("That doesn't look like a valid web address.", 400);
  }
  if (insecureDevHosts().includes(url.host.toLowerCase())) return url;
  if (url.protocol !== "https:") throw new CanvasError("The Canvas address must use https.", 400);
  if (url.username || url.password) throw new CanvasError("The Canvas address can't include credentials.", 400);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) || !host.includes(".") || /\.(local|internal|lan|home|localhost)$/i.test(host)) {
    throw new CanvasError("The Canvas address must be a public school Canvas site.", 400);
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new CanvasError(`Couldn't find a site at ${host}. Check the address.`, 400);
  }
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new CanvasError("The Canvas address must be a public school Canvas site.", 400);
  }
  return url;
}

/** Accepts "school.instructure.com" or any pasted Canvas page URL and returns the site origin. */
export async function normalizeBaseUrl(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) throw new CanvasError("Enter your school's Canvas address.", 400);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return (await assertSafeUrl(withScheme)).origin;
}

// ---- HTTP -----------------------------------------------------------------

const API_HEADERS = {
  // Canvas ids can exceed JavaScript's safe integer range.
  Accept: "application/json+canvas-string-ids",
};

/** Canvas answers the API in JSON; anything else means this isn't a Canvas API address. */
async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text.replace(/^while\(1\);/, "")) as T;
  } catch {
    throw new CanvasError("That address answered, but not like Canvas does. Check your school's Canvas address.", 502);
  }
}

async function request(session: CanvasSession, url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { ...API_HEADERS, Authorization: `Bearer ${session.accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new CanvasError(
      timedOut ? "Canvas took too long to answer. Try again in a moment." : "Couldn't reach Canvas. Check the address and try again.",
      502,
    );
  }
  if (res.status >= 300 && res.status < 400) {
    // Canvas sends people to a login page when it doesn't accept the credential.
    throw new CanvasError("Canvas didn't accept the sign-in and sent us to its login page. Check the token and address.", 401);
  }
  if (res.status === 401) {
    // Canvas uses 401 both for a bad token and for "this user may not see this".
    const body = await res.text().catch(() => "");
    if (/"status"\s*:\s*"unauthorized"/.test(body) && !/access token/i.test(body)) {
      throw new CanvasError("Canvas doesn't let this account see that.", 403);
    }
    throw new CanvasError("Canvas rejected the sign-in. The token may be wrong, expired, or revoked.", 401);
  }
  if (res.status === 403 && res.headers.get("x-rate-limit-remaining") === "0.0") {
    throw new CanvasError("Canvas is rate-limiting requests. Wait a moment and try again.", 429);
  }
  if (res.status === 403) throw new CanvasError("Canvas doesn't let this account see that.", 403);
  if (res.status === 404) throw new CanvasError("Canvas couldn't find that. It may have been removed or unpublished.", 404);
  if (!res.ok) {
    throw new CanvasError(`Canvas returned an error (${res.status}). Try again in a moment.`, res.status >= 500 ? 502 : res.status);
  }
  return res;
}

/**
 * Finds the real Canvas site behind what the student typed, before any token is
 * sent. Follows a school's redirect (e.g. canvas.school.edu → school.instructure.com)
 * and confirms the address really speaks the Canvas API.
 */
export async function resolveCanvasSite(baseUrl: string): Promise<string> {
  let origin = baseUrl;
  for (let hop = 0; hop < 4; hop++) {
    let res: Response;
    try {
      res = await fetch(`${origin}/api/v1/courses`, {
        headers: API_HEADERS,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      throw new CanvasError(`Couldn't reach ${new URL(origin).host}. Check your school's Canvas address.`, 502);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      const next = location ? new URL(location, origin) : null;
      if (next && next.origin !== origin) {
        origin = (await assertSafeUrl(next.origin)).origin;
        continue;
      }
    }
    const type = res.headers.get("content-type") ?? "";
    // A real Canvas answers this unauthenticated request with a JSON 401.
    if ((res.status === 401 || res.ok) && type.includes("json")) return origin;
    break;
  }
  throw new CanvasError(
    `${new URL(origin).host} doesn't look like a Canvas site. Use the address you see when you're in Canvas, like myschool.instructure.com.`,
    400,
  );
}

function apiUrl(session: CanvasSession, path: string, params?: Record<string, string | string[]>): string {
  const url = new URL(`/api/v1${path}`, session.baseUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
  }
  return url.toString();
}

async function getOne<T>(session: CanvasSession, path: string, params?: Record<string, string | string[]>): Promise<T> {
  const res = await request(session, apiUrl(session, path, params));
  return readJson<T>(res);
}

/** Follows Canvas's Link-header pagination, bounded so one request can't crawl forever. */
async function getAll<T>(
  session: CanvasSession,
  path: string,
  params?: Record<string, string | string[]>,
  maxPages = 8,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = apiUrl(session, path, { per_page: "100", ...params });
  for (let page = 0; url && page < maxPages; page++) {
    const res = await request(session, url);
    const page_ = await readJson<T[]>(res);
    if (!Array.isArray(page_)) break;
    out.push(...page_);
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    // Only follow pagination links that stay on the same Canvas site.
    url = next && new URL(next).origin === new URL(session.baseUrl).origin ? next : null;
  }
  return out;
}

/** Returns null instead of throwing when a student isn't allowed to list a section. */
async function getAllOptional<T>(
  session: CanvasSession,
  path: string,
  params?: Record<string, string | string[]>,
): Promise<T[] | null> {
  try {
    return await getAll<T>(session, path, params);
  } catch (err) {
    if (err instanceof CanvasError && [403, 404].includes(err.status)) return null;
    throw err;
  }
}

// ---- OAuth ------------------------------------------------------------------

export interface OAuthConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string;
  redirectUri: string;
}

export function oauthConfig(): OAuthConfig | null {
  const baseUrl = process.env.CANVAS_OAUTH_BASE_URL?.trim().replace(/\/+$/, "");
  const clientId = process.env.CANVAS_CLIENT_ID?.trim();
  const clientSecret = process.env.CANVAS_CLIENT_SECRET?.trim();
  if (!baseUrl || !clientId || !clientSecret) return null;
  const appUrl = (process.env.APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
  return {
    baseUrl,
    clientId,
    clientSecret,
    scopes: process.env.CANVAS_OAUTH_SCOPES?.trim() || undefined,
    redirectUri: `${appUrl}/api/canvas/oauth/callback`,
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { name?: string };
}

async function tokenRequest(config: OAuthConfig, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${config.baseUrl}/login/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...body,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new CanvasError("Canvas sign-in failed. Please try connecting again.", 401);
  return readJson<TokenResponse>(res);
}

export async function exchangeOAuthCode(config: OAuthConfig, code: string): Promise<CanvasSession> {
  const token = await tokenRequest(config, {
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
    code,
  });
  return {
    baseUrl: config.baseUrl,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    userName: token.user?.name ?? "Canvas user",
    via: "oauth",
  };
}

const refreshes = new Map<string, Promise<TokenResponse>>();

/** OAuth access tokens last about an hour; refresh shortly before they lapse. */
export async function ensureFresh(session: CanvasSession): Promise<CanvasSession> {
  if (session.via !== "oauth" || !session.expiresAt || session.expiresAt - Date.now() > 60_000) {
    return session;
  }
  const config = oauthConfig();
  if (!config || !session.refreshToken) {
    throw new CanvasError("Your Canvas sign-in expired. Please connect again.", 401);
  }
  // Several requests can arrive at once with the same expiring token (and the
  // refreshed cookie takes a moment to reach the browser); refresh once for all of them.
  const key = session.refreshToken;
  let pending = refreshes.get(key);
  if (!pending) {
    pending = tokenRequest(config, { grant_type: "refresh_token", refresh_token: key });
    refreshes.set(key, pending);
    const forget = () => refreshes.delete(key);
    pending.then(() => setTimeout(forget, 30_000).unref(), forget);
  }
  const token = await pending;
  const fresh: CanvasSession = {
    ...session,
    accessToken: token.access_token,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
  };
  await writeCanvasSession(fresh);
  return fresh;
}

// ---- Reads ------------------------------------------------------------------

interface RawCourse {
  id: string;
  name?: string;
  course_code?: string;
  term?: { name?: string };
  syllabus_body?: string | null;
  access_restricted_by_date?: boolean;
  enrollments?: { type?: string; computed_current_score?: number | null }[];
}

interface RawAssignment {
  id: string;
  name: string;
  description?: string | null;
  due_at?: string | null;
  points_possible?: number | null;
  submission_types?: string[];
  is_quiz_assignment?: boolean;
  submission?: {
    score?: number | null;
    submitted_at?: string | null;
    missing?: boolean;
    workflow_state?: string;
  } | null;
}

interface RawModuleItem {
  id: string;
  title: string;
  type: string;
  content_id?: string;
  page_url?: string;
}

interface RawModule {
  id: string;
  name: string;
  items_count?: number;
  items?: RawModuleItem[];
}

function toCourse(raw: RawCourse): CanvasCourse {
  const student = raw.enrollments?.find((e) => e.type === "student") ?? raw.enrollments?.[0];
  return {
    id: String(raw.id),
    name: raw.name ?? raw.course_code ?? "Untitled course",
    code: raw.course_code,
    term: raw.term?.name,
    currentScore: student?.computed_current_score ?? null,
  };
}

function toAssignment(raw: RawAssignment): CanvasAssignment {
  const sub = raw.submission;
  return {
    id: String(raw.id),
    name: raw.name,
    dueAt: raw.due_at ?? null,
    pointsPossible: raw.points_possible ?? null,
    score: sub?.score ?? null,
    submitted: Boolean(sub?.submitted_at) || sub?.workflow_state === "graded",
    missing: Boolean(sub?.missing),
    isQuiz: Boolean(raw.is_quiz_assignment) || Boolean(raw.submission_types?.includes("online_quiz")),
  };
}

export async function getSelf(session: CanvasSession): Promise<{ name: string }> {
  const me = await getOne<{ name?: string; short_name?: string }>(session, "/users/self");
  return { name: me.short_name ?? me.name ?? "Canvas user" };
}

export async function listCourses(session: CanvasSession): Promise<CanvasCourse[]> {
  const raw = await getAll<RawCourse>(session, "/courses", {
    enrollment_state: "active",
    "include[]": ["term", "total_scores"],
  });
  return raw
    .filter((c) => c.name && !c.access_restricted_by_date)
    .map(toCourse)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function assertId(value: string, what: string): string {
  if (!/^\d{1,20}$/.test(value)) throw new CanvasError(`Invalid ${what}.`, 400);
  return value;
}

function moduleItemToMaterial(item: RawModuleItem): CanvasMaterial | null {
  switch (item.type) {
    case "Page":
      return item.page_url
        ? { ref: `page:${item.page_url}`, kind: "page", title: item.title, importable: true }
        : null;
    case "File": {
      const ok = isSupportedFileName(item.title);
      return item.content_id
        ? {
            ref: `file:${item.content_id}`,
            kind: "file",
            title: item.title,
            // Module titles often drop the extension; the type is re-checked on import.
            importable: ok || !/\.[a-z0-9]{2,5}$/i.test(item.title),
            note: ok ? undefined : "may be an unsupported file type",
          }
        : null;
    }
    case "Assignment":
      return item.content_id
        ? { ref: `assignment:${item.content_id}`, kind: "assignment", title: item.title, importable: true }
        : null;
    case "SubHeader":
      return null;
    default:
      return {
        ref: `other:${item.id}`,
        kind: "other",
        title: item.title,
        importable: false,
        note: item.type === "Quiz" ? "quizzes aren't imported" : "can't be imported",
      };
  }
}

export async function getCourseOverview(session: CanvasSession, courseIdRaw: string): Promise<CanvasCourseOverview> {
  const courseId = assertId(courseIdRaw, "course");
  const base = `/courses/${courseId}`;
  const [course, modules, pages, files, assignments] = await Promise.all([
    getOne<RawCourse>(session, base, { "include[]": ["syllabus_body", "term", "total_scores"] }),
    getAllOptional<RawModule>(session, `${base}/modules`, { "include[]": "items" }),
    getAllOptional<{ url: string; title: string }>(session, `${base}/pages`, { sort: "title", published: "true" }),
    getAllOptional<{ id: string; display_name: string; size?: number }>(session, `${base}/files`, { sort: "name" }),
    getAllOptional<RawAssignment>(session, `${base}/assignments`, { "include[]": "submission", order_by: "due_at" }),
  ]);

  // Canvas leaves `items` off large modules; fetch those separately.
  const fullModules = await Promise.all(
    (modules ?? []).map(async (m) => {
      const items =
        m.items ??
        (m.items_count
          ? ((await getAllOptional<RawModuleItem>(session, `${base}/modules/${m.id}/items`)) ?? [])
          : []);
      return {
        id: String(m.id),
        name: m.name,
        items: items.map(moduleItemToMaterial).filter((x): x is CanvasMaterial => x !== null),
      };
    }),
  );

  const unavailable: string[] = [];
  if (modules === null) unavailable.push("Modules");
  if (pages === null) unavailable.push("Pages");
  if (files === null) unavailable.push("Files");
  if (assignments === null) unavailable.push("Assignments");

  return {
    course: toCourse(course),
    hasSyllabus: Boolean(course.syllabus_body?.trim()),
    modules: fullModules.filter((m) => m.items.length > 0),
    pages: (pages ?? []).map((p) => ({ ref: `page:${p.url}`, kind: "page", title: p.title, importable: true })),
    files: (files ?? []).map((f) => {
      const ok = isSupportedFileName(f.display_name) && (f.size ?? 0) <= MAX_FILE_BYTES;
      return {
        ref: `file:${f.id}`,
        kind: "file",
        title: f.display_name,
        importable: ok,
        note: ok ? undefined : (f.size ?? 0) > MAX_FILE_BYTES ? "larger than 25 MB" : "unsupported file type",
      };
    }),
    assignments: (assignments ?? []).map(toAssignment),
    unavailable,
  };
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  }).trim();
}

export type FetchedMaterial =
  | { name: string; text: string }
  | { name: string; mime: string; bytes: Buffer };

/** Downloads a Canvas file. The signed download URL may live on a CDN host, so
 *  each hop is validated and the API token is never sent along. */
async function download(url: string): Promise<Buffer> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const safe = await assertSafeUrl(current);
    const res = await fetch(safe, {
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      current = new URL(location, safe).toString();
      continue;
    }
    if (!res.ok) throw new CanvasError(`Canvas wouldn't release the file (${res.status}).`, res.status);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_FILE_BYTES) throw new CanvasError("File is larger than 25 MB.", 413);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) throw new CanvasError("File is larger than 25 MB.", 413);
    return bytes;
  }
  throw new CanvasError("Couldn't download the file from Canvas.", 502);
}

export async function fetchMaterial(session: CanvasSession, courseIdRaw: string, ref: string): Promise<FetchedMaterial> {
  const courseId = assertId(courseIdRaw, "course");
  const base = `/courses/${courseId}`;
  const [kind, ...rest] = ref.split(":");
  const id = rest.join(":");

  if (kind === "syllabus") {
    const course = await getOne<RawCourse>(session, base, { "include[]": "syllabus_body" });
    return { name: `Syllabus: ${course.name ?? "course"}`, text: htmlToText(course.syllabus_body ?? "") };
  }
  if (kind === "page") {
    const page = await getOne<{ title: string; body?: string | null }>(
      session,
      `${base}/pages/${encodeURIComponent(id)}`,
    );
    return { name: page.title, text: htmlToText(page.body ?? "") };
  }
  if (kind === "assignment") {
    const a = await getOne<RawAssignment>(session, `${base}/assignments/${assertId(id, "assignment")}`);
    return { name: `Assignment: ${a.name}`, text: htmlToText(a.description ?? "") };
  }
  if (kind === "file") {
    const file = await getOne<{ display_name: string; url?: string; size?: number; "content-type"?: string }>(
      session,
      `${base}/files/${assertId(id, "file")}`,
    );
    if ((file.size ?? 0) > MAX_FILE_BYTES) throw new CanvasError("File is larger than 25 MB.", 413);
    if (!file.url) throw new CanvasError("Canvas didn't provide a download link (the file may be locked).", 403);
    return {
      name: file.display_name,
      mime: file["content-type"] ?? "application/octet-stream",
      bytes: await download(file.url),
    };
  }
  throw new CanvasError("Unknown Canvas item.", 400);
}

// ---- Personalization --------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Summarizes what the student has coming up and how recent work went, so the
 * resources can emphasize what matters for them. The student's name and ids are
 * deliberately left out: the model doesn't need them.
 */
export async function buildStudentContext(session: CanvasSession, courseIdRaw: string, now = Date.now()): Promise<string | null> {
  const courseId = assertId(courseIdRaw, "course");
  const base = `/courses/${courseId}`;
  const [course, assignments] = await Promise.all([
    getOne<RawCourse>(session, base, { "include[]": ["term", "total_scores"] }),
    getAllOptional<RawAssignment>(session, `${base}/assignments`, { "include[]": "submission", order_by: "due_at" }),
  ]);
  if (!assignments) return null;

  const info = toCourse(course);
  const lines: string[] = [`Course: ${info.name}${info.term ? ` (${info.term})` : ""}`];
  if (typeof info.currentScore === "number") lines.push(`Current course grade: ${info.currentScore}%`);

  const upcoming = assignments
    .filter((a) => a.due_at && Date.parse(a.due_at) >= now && Date.parse(a.due_at) <= now + 30 * DAY)
    .filter((a) => !a.submission?.submitted_at)
    .slice(0, 10);
  if (upcoming.length) {
    lines.push("", "Coming up in the next 30 days:");
    for (const a of upcoming) {
      const kind = toAssignment(a).isQuiz ? "quiz/test" : "assignment";
      const days = Math.max(0, Math.round((Date.parse(a.due_at!) - now) / DAY));
      const desc = a.description ? ` — ${clip(htmlToText(a.description), 600)}` : "";
      lines.push(`- ${a.name} (${kind}, due in ${days} day${days === 1 ? "" : "s"}${a.points_possible ? `, ${a.points_possible} pts` : ""})${desc}`);
    }
  }

  const graded = assignments
    .filter((a) => typeof a.submission?.score === "number" && (a.points_possible ?? 0) > 0)
    .sort((a, b) => Date.parse(b.due_at ?? "") - Date.parse(a.due_at ?? "") || 0)
    .slice(0, 15);
  if (graded.length) {
    lines.push("", "Recent graded work (most recent first):");
    for (const a of graded) {
      const pct = Math.round((a.submission!.score! / a.points_possible!) * 100);
      lines.push(`- ${a.name}: ${a.submission!.score}/${a.points_possible} (${pct}%)${pct < 75 ? " — struggled here" : ""}`);
    }
  }

  const missing = assignments.filter((a) => a.submission?.missing).slice(0, 8);
  if (missing.length) {
    lines.push("", `Missing work: ${missing.map((a) => a.name).join("; ")}`);
  }

  return lines.length > 2 ? lines.join("\n") : null;
}
