"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasSelection } from "@/components/CanvasPanel";
import { Create, type CreateOptions } from "@/components/Create";
import { titleOf } from "@/components/Markdown";
import { type ResourceStates, StudyView } from "@/components/StudyView";
import { RequestError, api, loadLibrary, newId, saveLibrary, streamGenerate } from "@/lib/client";
import type { GenerateOptions, MaterialSummary, ResourceKind, SessionInfo, StudySet } from "@/lib/types";

const ALL: ResourceKind[] = ["lesson", "review", "quiz"];
const OPTIONS_KEY = "studykit.options.v1";
const DEFAULT_OPTIONS: CreateOptions = { gradeLevel: "High school", quizLength: 15, focus: "" };

function idleStates(set?: StudySet): ResourceStates {
  return {
    lesson: { status: set?.lesson ? "done" : "idle" },
    review: { status: set?.review ? "done" : "idle" },
    quiz: { status: set?.quiz ? "done" : "idle" },
  };
}

function AccessGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/access", { method: "POST", body: JSON.stringify({ code }) });
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code isn't right.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card gate" onSubmit={submit}>
      <h2>Enter your access code</h2>
      <p className="muted">StudyKit is in private testing. Ask whoever invited you for the code.</p>
      <input type="password" value={code} onChange={(e) => setCode(e.target.value)} autoFocus aria-label="Access code" />
      {error && <p className="error-text">{error}</p>}
      <button className="btn btn-primary" disabled={busy || !code}>
        Continue
      </button>
    </form>
  );
}

export default function Home() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [library, setLibrary] = useState<StudySet[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [options, setOptionsState] = useState<CreateOptions>(DEFAULT_OPTIONS);
  const [canvas, setCanvas] = useState<CanvasSelection | null>(null);

  const [current, setCurrent] = useState<StudySet | null>(null);
  const [states, setStates] = useState<ResourceStates>(idleStates());
  const [tab, setTab] = useState<ResourceKind>("lesson");
  const [quizProgress, setQuizProgress] = useState(0);
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [personalized, setPersonalized] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const abort = useRef<AbortController | null>(null);

  const refreshSession = useCallback(() => {
    api<SessionInfo>("/api/session")
      .then(setSession)
      .catch(() => setSession({ locked: false, oauthAvailable: false, canvas: null }));
  }, []);

  useEffect(() => {
    refreshSession();
    libraryRef.current = loadLibrary();
    setLibrary(libraryRef.current);
    try {
      const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null") as Partial<CreateOptions> | null;
      if (saved) setOptionsState((o) => ({ ...o, gradeLevel: saved.gradeLevel ?? o.gradeLevel, quizLength: saved.quizLength ?? o.quizLength }));
    } catch {
      // Ignore unreadable preferences.
    }
    const result = new URLSearchParams(window.location.search).get("canvas");
    if (result) {
      if (result !== "connected") {
        setNotice(result === "denied" ? "Canvas access wasn't approved." : "Canvas sign-in didn't complete. Please try again.");
      }
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [refreshSession]);

  const setOptions = useCallback((next: CreateOptions) => {
    setOptionsState(next);
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify({ gradeLevel: next.gradeLevel, quizLength: next.quizLength }));
    } catch {
      // Preferences are optional.
    }
  }, []);

  const libraryRef = useRef<StudySet[]>([]);
  const currentRef = useRef<StudySet | null>(null);
  currentRef.current = current;

  const updateLibrary = useCallback((next: StudySet[]) => {
    libraryRef.current = next;
    setLibrary(next);
    if (!saveLibrary(next)) setNotice("This browser's storage is full, so the oldest study sets weren't saved.");
  }, []);

  const persist = useCallback(
    (set: StudySet) => updateLibrary([set, ...libraryRef.current.filter((s) => s.id !== set.id)]),
    [updateLibrary],
  );

  const generate = useCallback(
    async (resources: ResourceKind[], base: StudySet | null) => {
      detach();
      const controller = new AbortController();
      abort.current = controller;
      setError(null);

      const request: GenerateOptions = {
        resources,
        quizLength: options.quizLength,
        gradeLevel: options.gradeLevel,
        focus: options.focus,
        canvas: canvas ? { courseId: canvas.courseId, refs: canvas.refs, personalize: canvas.personalize } : undefined,
      };
      const form = new FormData();
      form.set("options", JSON.stringify(request));
      if (text.trim()) form.set("text", text);
      for (const file of files) form.append("files", file);

      // Text arrives in many small pieces; collect it here and paint a few times a second.
      const draft: StudySet = base
        ? { ...base }
        : { id: newId(), title: "New study set", createdAt: Date.now(), sources: [], lesson: "", review: "", quiz: null };
      for (const kind of resources) {
        if (kind === "quiz") draft.quiz = null;
        else draft[kind] = "";
      }
      let dirty = false;
      const paint = () => {
        if (!dirty) return;
        dirty = false;
        setCurrent({ ...draft });
      };
      const painter = setInterval(paint, 120);

      const setState = (kind: ResourceKind, state: ResourceStates[ResourceKind]) =>
        setStates((prev) => ({ ...prev, [kind]: state }));
      const refreshTitle = () => {
        draft.title =
          titleOf(draft.lesson) ??
          titleOf(draft.review)?.replace(/\s*[—–-]\s*Review$/i, "") ??
          draft.quiz?.title ??
          draft.sources[0] ??
          draft.title;
      };

      let started = false;
      const finished = new Set<ResourceKind>();
      setGenerating(true);
      try {
        for await (const event of streamGenerate(form, controller.signal)) {
          if (!started) {
            // The server accepted the material: switch to the study view.
            started = true;
            setCurrent({ ...draft });
            setStates((prev) => {
              const next = base ? { ...prev } : idleStates();
              for (const kind of resources) next[kind] = { status: "waiting" };
              return next;
            });
            setQuizProgress(0);
            setTab(resources[0]);
            setCanRetry(true);
            window.scrollTo({ top: 0 });
          }
          switch (event.type) {
            case "materials":
              if (!base) {
                draft.sources = event.items.map((m) => m.name);
                setMaterials(event.items);
                setPersonalized(event.personalized);
              }
              setWarnings(event.warnings);
              dirty = true;
              break;
            case "delta":
              if (!draft[event.resource]) setState(event.resource, { status: "streaming" });
              draft[event.resource] += event.text;
              if (draft.title === "New study set" && event.resource === "lesson" && draft.lesson.includes("\n")) refreshTitle();
              dirty = true;
              break;
            case "progress":
              setQuizProgress(event.count);
              break;
            case "done":
              if (event.resource === "quiz") draft.quiz = event.quiz ?? null;
              else if (event.text) draft[event.resource] = event.text;
              refreshTitle();
              dirty = true;
              finished.add(event.resource);
              setState(event.resource, { status: "done", truncated: event.truncated });
              break;
            case "error":
              if (event.resource) setState(event.resource, { status: "error", error: event.message });
              else setError(event.message);
              break;
            case "end":
              break;
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          const message =
            err instanceof RequestError ? err.message : "The connection dropped while generating. Check your internet and try again.";
          if (!started) {
            setError(message);
            if (err instanceof RequestError && err.status === 401) refreshSession();
          }
        }
      } finally {
        clearInterval(painter);
        // If the user moved on to something else, leave the screen alone.
        if (abort.current === controller) {
          abort.current = null;
          setGenerating(false);
          if (started) {
            dirty = true;
            paint();
            const reason = controller.signal.aborted
              ? "You stopped this before it finished."
              : "Generation stopped before this finished. Check your connection and try again.";
            setStates((prev) => {
              const next = { ...prev };
              for (const kind of resources) {
                if (next[kind].status === "waiting" || next[kind].status === "streaming") {
                  next[kind] = { status: "error", error: reason };
                }
              }
              return next;
            });
          }
        }
        // Save only what completed; half-written resources aren't kept.
        if (finished.size > 0) {
          const saved = { ...draft };
          for (const kind of resources) {
            if (finished.has(kind)) continue;
            if (kind === "quiz") saved.quiz = null;
            else saved[kind] = "";
          }
          persist(saved);
        }
      }
    },
    [options, canvas, text, files, persist, refreshSession],
  );

  const detach = () => {
    const controller = abort.current;
    abort.current = null;
    controller?.abort();
    setGenerating(false);
  };

  const openSet = (set: StudySet) => {
    detach();
    setCurrent(set);
    setStates(idleStates(set));
    setTab(set.lesson ? "lesson" : set.review ? "review" : "quiz");
    setMaterials([]);
    setWarnings([]);
    setPersonalized(false);
    setCanRetry(false);
    window.scrollTo({ top: 0 });
  };

  const goHome = () => {
    if (generating && !window.confirm("Your study set is still being written. Leave anyway?")) return;
    detach();
    setCurrent(null);
    setError(null);
  };

  const startOver = () => {
    goHome();
    setFiles([]);
    setText("");
    setOptionsState((o) => ({ ...o, focus: "" }));
  };

  const removeSet = (id: string) => updateLibrary(libraryRef.current.filter((s) => s.id !== id));

  const onQuizFinish = useCallback(
    (result: { correct: number; total: number; points: number }) => {
      const set = currentRef.current;
      if (!set) return;
      const best = set.bestScore;
      if (best && best.total === result.total && best.points >= result.points) return;
      const updated = { ...set, bestScore: result };
      setCurrent(updated);
      persist(updated);
    },
    [persist],
  );

  return (
    <>
      <header className="topbar">
        <button className="brand" onClick={goHome} aria-label="StudyKit home">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          StudyKit
        </button>
        {current && (
          <div className="topbar-actions">
            {generating && (
              <button className="btn btn-small" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            )}
            <button className="btn btn-small" onClick={goHome}>
              Back
            </button>
            <button className="btn btn-small btn-primary" onClick={startOver}>
              New study set
            </button>
          </div>
        )}
      </header>

      <main className={current ? "page page-study" : "page"}>
        {notice && (
          <p className="notice dismissible">
            {notice}
            <button className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </p>
        )}

        {!session ? (
          <p className="muted loading">Loading…</p>
        ) : session.locked ? (
          <AccessGate onUnlocked={refreshSession} />
        ) : current ? (
          <StudyView
            set={current}
            states={states}
            quizProgress={quizProgress}
            quizLength={options.quizLength}
            materials={materials}
            warnings={warnings}
            personalized={personalized}
            tab={tab}
            setTab={setTab}
            onRetry={canRetry && !generating ? (kind) => void generate([kind], current) : undefined}
            onQuizFinish={onQuizFinish}
          />
        ) : (
          <div className="home">
            <div className="home-main">
              <div className="hero">
                <h1>Turn any class material into a way to learn it.</h1>
                <p>
                  Upload notes, slides or readings and get a full lesson, a short review, and a tap-to-answer practice
                  quiz — built from your material.
                </p>
              </div>
              <Create
                files={files}
                setFiles={setFiles}
                text={text}
                setText={setText}
                options={options}
                setOptions={setOptions}
                session={session}
                refreshSession={refreshSession}
                canvas={canvas}
                setCanvas={setCanvas}
                onGenerate={() => void generate(ALL, null)}
                error={error}
              />
              {generating && (
                <div className="overlay" role="status">
                  <div className="overlay-card">
                    <span className="spinner" aria-hidden="true" />
                    <p>Reading your material…</p>
                    <button className="btn btn-small" onClick={() => abort.current?.abort()}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            <aside className="library">
              <h2>Your study sets</h2>
              {library.length === 0 ? (
                <p className="muted">Study sets you create are saved in this browser and show up here.</p>
              ) : (
                <ul>
                  {library.map((set) => (
                    <li key={set.id}>
                      <button className="library-item" onClick={() => openSet(set)}>
                        <strong>{set.title}</strong>
                        <span className="muted">
                          {new Date(set.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          {set.quiz ? ` · ${set.quiz.questions.length} questions` : ""}
                          {set.bestScore ? ` · best ${set.bestScore.correct}/${set.bestScore.total}` : ""}
                        </span>
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`Delete ${set.title}`}
                        onClick={() => window.confirm(`Delete "${set.title}"?`) && removeSet(set.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          </div>
        )}
      </main>
    </>
  );
}
