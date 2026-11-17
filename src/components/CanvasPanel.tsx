"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RequestError, api } from "@/lib/client";
import type { CanvasCourse, CanvasCourseOverview, CanvasMaterial, SessionInfo } from "@/lib/types";

export interface CanvasSelection {
  courseId: string;
  courseName: string;
  refs: string[];
  personalize: boolean;
}

function dueLabel(iso: string): string {
  const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
  if (days <= 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due in ${days} days`;
}

function ConnectForm({ session, onConnected }: { session: SessionInfo; onConnected: () => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(!session.oauthAvailable);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/canvas/connect", { method: "POST", body: JSON.stringify({ baseUrl, token, consent }) });
      setToken("");
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="canvas-connect">
      <p className="muted">
        Connect Canvas to pull in pages, files and assignments from your courses, and to focus your study set on
        what&apos;s coming up.
      </p>
      <details className="disclosure">
        <summary>What this app can see, and what it does with it</summary>
        <ul>
          <li>
            <strong>Read-only.</strong> It reads your courses, modules, pages, files, assignments and grades. It never
            submits, edits or posts anything.
          </li>
          <li>
            Only the items you tick, plus a short summary of upcoming work and recent scores (if you leave
            personalization on), are sent to the AI model to write your study set. Your name is not sent.
          </li>
          <li>
            Your Canvas sign-in is kept encrypted in a cookie in this browser. It isn&apos;t stored on a server, and
            Disconnect removes it.
          </li>
          <li>You can also revoke access at any time in Canvas under Account → Settings → Approved Integrations.</li>
        </ul>
      </details>

      <label className="check consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>
          This is my own Canvas account, and I&apos;m allowed to connect it (if I&apos;m under 18, a parent or guardian
          has said it&apos;s OK).
        </span>
      </label>

      {session.oauthAvailable && (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!consent}
            onClick={() => window.location.assign("/api/canvas/oauth/start")}
          >
            Sign in with Canvas ({session.oauthHost})
          </button>
          {!showToken && (
            <button type="button" className="link" onClick={() => setShowToken(true)}>
              Use an access token instead
            </button>
          )}
        </>
      )}

      {showToken && (
        <form onSubmit={connect} className="token-form">
          <label>
            <span>Your school&apos;s Canvas address</span>
            <input
              type="text"
              inputMode="url"
              autoComplete="url"
              placeholder="myschool.instructure.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              required
            />
          </label>
          <label>
            <span>Access token</span>
            <input
              type="password"
              autoComplete="off"
              placeholder="Paste the token from Canvas"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
          </label>
          <details className="disclosure">
            <summary>How do I get a token?</summary>
            <ol>
              <li>In Canvas, open Account → Settings.</li>
              <li>
                Under Approved Integrations, choose <em>+ New Access Token</em>.
              </li>
              <li>Name it “StudyKit”, set an expiry date, and generate it.</li>
              <li>Copy the token and paste it here. Treat it like a password.</li>
            </ol>
            <p>If you don&apos;t see that button, your school has turned tokens off — ask a teacher or use uploads.</p>
          </details>
          {error && <p className="error-text">{error}</p>}
          <button className="btn btn-primary" disabled={busy || !consent}>
            {busy ? "Connecting…" : "Connect Canvas"}
          </button>
        </form>
      )}
    </div>
  );
}

function MaterialList({
  items,
  selected,
  toggle,
}: {
  items: CanvasMaterial[];
  selected: Set<string>;
  toggle: (refs: string[], on: boolean) => void;
}) {
  return (
    <ul className="material-list">
      {items.map((item, i) => (
        <li key={`${item.ref}-${i}`}>
          <label className={`check${item.importable ? "" : " is-off"}`}>
            <input
              type="checkbox"
              disabled={!item.importable}
              checked={selected.has(item.ref)}
              onChange={(e) => toggle([item.ref], e.target.checked)}
            />
            <span>
              <span className={`kind kind-${item.kind}`}>{item.kind === "other" ? "item" : item.kind}</span>
              {item.title}
              {item.note && <em className="muted"> — {item.note}</em>}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function Group({
  title,
  items,
  selected,
  toggle,
  defaultOpen = false,
}: {
  title: string;
  items: CanvasMaterial[];
  selected: Set<string>;
  toggle: (refs: string[], on: boolean) => void;
  defaultOpen?: boolean;
}) {
  const importable = items.filter((i) => i.importable).map((i) => i.ref);
  const picked = importable.filter((r) => selected.has(r)).length;
  const all = importable.length > 0 && picked === importable.length;
  return (
    <details className="group" open={defaultOpen}>
      <summary>
        <span className="group-title">{title}</span>
        <span className="muted">{picked > 0 ? `${picked} of ${items.length} selected` : `${items.length}`}</span>
      </summary>
      {importable.length > 1 && (
        <button type="button" className="link" onClick={() => toggle(importable, !all)}>
          {all ? "Clear all" : "Select all"}
        </button>
      )}
      <MaterialList items={items} selected={selected} toggle={toggle} />
    </details>
  );
}

export function CanvasPanel({
  session,
  refreshSession,
  onChange,
}: {
  session: SessionInfo;
  refreshSession: () => void;
  onChange: (selection: CanvasSelection | null) => void;
}) {
  const [courses, setCourses] = useState<CanvasCourse[] | null>(null);
  const [courseId, setCourseId] = useState("");
  const [overview, setOverview] = useState<CanvasCourseOverview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [personalize, setPersonalize] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = session.canvas !== null;

  const handleError = useCallback(
    (err: unknown) => {
      setError(err instanceof Error ? err.message : "Couldn't load from Canvas.");
      if (err instanceof RequestError && err.status === 401) refreshSession();
    },
    [refreshSession],
  );

  useEffect(() => {
    if (!connected) {
      setCourses(null);
      setCourseId("");
      setOverview(null);
      setSelected(new Set());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ courses: CanvasCourse[] }>("/api/canvas/courses")
      .then((data) => !cancelled && setCourses(data.courses))
      .catch((err) => !cancelled && handleError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [connected, handleError]);

  useEffect(() => {
    setOverview(null);
    setSelected(new Set());
    if (!courseId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<CanvasCourseOverview>(`/api/canvas/courses/${courseId}`)
      .then((data) => !cancelled && setOverview(data))
      .catch((err) => !cancelled && handleError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [courseId, handleError]);

  useEffect(() => {
    if (!connected || !courseId || !overview) return onChange(null);
    onChange({ courseId, courseName: overview.course.name, refs: [...selected], personalize });
  }, [connected, courseId, overview, selected, personalize, onChange]);

  const toggle = useCallback((refs: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const ref of refs) {
        if (on) next.add(ref);
        else next.delete(ref);
      }
      return next;
    });
  }, []);

  const disconnect = async () => {
    await api("/api/canvas/connect", { method: "DELETE" }).catch(() => null);
    refreshSession();
  };

  const upcoming = useMemo(
    () =>
      (overview?.assignments ?? [])
        .filter((a) => a.dueAt && Date.parse(a.dueAt) > Date.now() && !a.submitted)
        .slice(0, 4),
    [overview],
  );

  const graded = overview?.assignments ?? [];
  const struggled = graded
    .filter((a) => a.score != null && a.pointsPossible && a.score / a.pointsPossible < 0.75)
    .slice(-4);
  const missing = graded.filter((a) => a.missing).slice(0, 4);

  if (!connected) return <ConnectForm session={session} onConnected={refreshSession} />;

  const assignmentMaterials: CanvasMaterial[] = (overview?.assignments ?? [])
    .filter((a) => !a.isQuiz)
    .map((a) => ({ ref: `assignment:${a.id}`, kind: "assignment", title: a.name, importable: true }));
  const nothing =
    overview &&
    overview.modules.length === 0 &&
    overview.pages.length === 0 &&
    overview.files.length === 0 &&
    !overview.hasSyllabus &&
    assignmentMaterials.length === 0;

  return (
    <div className="canvas-connected">
      <div className="canvas-account">
        <span>
          Connected as <strong>{session.canvas!.userName}</strong> <span className="muted">· {session.canvas!.host}</span>
        </span>
        <button type="button" className="link" onClick={disconnect}>
          Disconnect
        </button>
      </div>

      <label className="field">
        <span>Course</span>
        <select value={courseId} onChange={(e) => setCourseId(e.target.value)} disabled={!courses}>
          <option value="">{courses ? "Choose a course…" : "Loading courses…"}</option>
          {courses?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="error-text">{error}</p>}
      {loading && courseId && <p className="muted">Loading course…</p>}
      {courses?.length === 0 && <p className="muted">No active courses were found on this account.</p>}

      {overview && (
        <>
          <label className="switch">
            <input type="checkbox" checked={personalize} onChange={(e) => setPersonalize(e.target.checked)} />
            <span>Personalize using my upcoming assignments and recent scores in this course</span>
          </label>
          {(upcoming.length > 0 || struggled.length > 0 || missing.length > 0 || overview.course.currentScore != null) && (
            <div className="insights">
              <strong>
                How this class is going
                {overview.course.currentScore != null && <> · {Math.round(overview.course.currentScore)}% so far</>}
              </strong>
              {upcoming.length > 0 && (
                <>
                  <h4>Coming up</h4>
                  <ul>
                    {upcoming.map((a) => (
                      <li key={a.id}>
                        <span>
                          {a.name}
                          {a.isQuiz ? " (quiz/test)" : ""}
                        </span>
                        <span className="muted">{dueLabel(a.dueAt!)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {struggled.length > 0 && (
                <>
                  <h4>Worth another look</h4>
                  <ul>
                    {struggled.map((a) => (
                      <li key={a.id}>
                        <span>{a.name}</span>
                        <span className="tag-low">
                          {a.score}/{a.pointsPossible} ({Math.round((a.score! / a.pointsPossible!) * 100)}%)
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {missing.length > 0 && (
                <>
                  <h4>Missing</h4>
                  <ul>
                    {missing.map((a) => (
                      <li key={a.id}>
                        <span>{a.name}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {personalize && (
                <p className="muted small">Your study set will lean toward what&apos;s coming up and what scored low.</p>
              )}
            </div>
          )}

          <p className="group-heading">Pick what to study from</p>
          {nothing && <p className="muted">This course has no pages, files or assignments you can import.</p>}
          {overview.hasSyllabus && (
            <label className="check syllabus">
              <input
                type="checkbox"
                checked={selected.has("syllabus")}
                onChange={(e) => toggle(["syllabus"], e.target.checked)}
              />
              <span>
                <span className="kind kind-syllabus">syllabus</span>Course syllabus
              </span>
            </label>
          )}
          {overview.modules.map((m, i) => (
            <Group key={m.id} title={m.name} items={m.items} selected={selected} toggle={toggle} defaultOpen={i === 0} />
          ))}
          {overview.pages.length > 0 && (
            <Group title="All pages" items={overview.pages} selected={selected} toggle={toggle} />
          )}
          {overview.files.length > 0 && (
            <Group title="All files" items={overview.files} selected={selected} toggle={toggle} />
          )}
          {assignmentMaterials.length > 0 && (
            <Group title="Assignment instructions" items={assignmentMaterials} selected={selected} toggle={toggle} />
          )}
          {overview.unavailable.length > 0 && (
            <p className="muted small">
              Your school hides {overview.unavailable.join(", ").toLowerCase()} for this course, so those aren&apos;t
              listed.
            </p>
          )}
        </>
      )}
    </div>
  );
}
