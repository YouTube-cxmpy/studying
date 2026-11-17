"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasSelection } from "@/components/CanvasPanel";
import { ClassView } from "@/components/ClassView";
import { Create, type CreateOptions } from "@/components/Create";
import { titleOf } from "@/components/Markdown";
import { type ResourceStates, StudyView, type Tab } from "@/components/StudyView";
import { RequestError, api, loadClassNotes, loadLibrary, newId, saveClassNotes, saveLibrary, streamGenerate } from "@/lib/client";
import type { NewQuizOptions } from "@/components/Quiz";
import type { GenerateOptions, MaterialSummary, QuizAttempt, QuizDifficulty, ResourceKind, SessionInfo, StudySet } from "@/lib/types";

const ALL: ResourceKind[] = ["lesson", "review", "cards", "quiz"];
const OPTIONS_KEY = "studykit.options.v1";
const DEFAULT_OPTIONS: CreateOptions = { gradeLevel: "High school", quizLength: 15, difficulty: "mixed", focus: "", course: "" };

function idleStates(set?: StudySet): ResourceStates {
  return {
    lesson: { status: set?.lesson ? "done" : "idle" },
    review: { status: set?.review ? "done" : "idle" },
    cards: { status: set?.cards?.length ? "done" : "idle" },
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
  const [tab, setTab] = useState<Tab>("lesson");
  const [classOpen, setClassOpen] = useState<string | null>(null);
  const [classNotes, setClassNotes] = useState<Record<string, string>>({});
  const [quizProgress, setQuizProgress] = useState(0);
  const [cardsProgress, setCardsProgress] = useState(0);
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
    setClassNotes(loadClassNotes());
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

  const draftRef = useRef<StudySet | null>(null);

  /** Changes fields on the study set on screen, the one being written, and its saved copy. */
  const patchSet = useCallback(
    (patch: Partial<StudySet>) => {
      const live = currentRef.current;
      if (!live) return;
      if (draftRef.current?.id === live.id) Object.assign(draftRef.current, patch);
      const updated = { ...live, ...patch };
      currentRef.current = updated;
      setCurrent(updated);
      const stored = libraryRef.current.find((s) => s.id === live.id);
      if (stored) persist({ ...stored, ...patch });
    },
    [persist],
  );

  const courses = useMemo(() => {
    const names = new Map<string, string>();
    for (const s of library) if (s.course?.trim()) names.set(s.course.trim().toLowerCase(), s.course.trim());
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }, [library]);

  const generate = useCallback(
    async (
      resources: ResourceKind[],
      base: StudySet | null,
      // A fresh quiz on a saved set: write from this text and steer away from these questions.
      extra?: { text: string; avoid?: string[]; quizLength?: number; difficulty?: QuizDifficulty; focusTopics?: string[] },
    ) => {
      detach();
      const controller = new AbortController();
      abort.current = controller;
      setError(null);

      const request: GenerateOptions = {
        resources,
        quizLength: extra?.quizLength ?? options.quizLength,
        gradeLevel: options.gradeLevel,
        focus: extra ? "" : options.focus,
        difficulty: extra?.difficulty ?? options.difficulty,
        focusTopics: extra?.focusTopics,
        avoid: extra?.avoid,
        canvas: !extra && canvas ? { courseId: canvas.courseId, refs: canvas.refs, personalize: canvas.personalize } : undefined,
      };
      const form = new FormData();
      form.set("options", JSON.stringify(request));
      if (extra) {
        form.set("text", extra.text);
      } else {
        if (text.trim()) form.set("text", text);
        for (const file of files) form.append("files", file);
      }

      // Text arrives in many small pieces; collect it here and paint a few times a second.
      const draft: StudySet = base
        ? { ...base }
        : {
            id: newId(),
            title: "New study set",
            createdAt: Date.now(),
            sources: [],
            lesson: "",
            review: "",
            quiz: null,
            cards: null,
            notes: "",
            course: options.course.trim() || canvas?.courseName || "",
          };
      draftRef.current = draft;
      const previousQuiz = base?.quiz ?? null;
      for (const kind of resources) {
        if (kind === "quiz") draft.quiz = null;
        else if (kind === "cards") draft.cards = null;
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
            setCardsProgress(0);
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
              if (event.resource === "quiz") setQuizProgress(event.count);
              else setCardsProgress(event.count);
              break;
            case "done":
              if (event.resource === "quiz") {
                draft.quiz = event.quiz ?? null;
                if (extra?.avoid) {
                  // The old best score belonged to the old questions.
                  draft.pastQuestions = extra.avoid;
                  delete draft.bestScore;
                }
              } else if (event.resource === "cards") {
                draft.cards = event.cards ?? null;
                draft.known = [];
              } else if (event.text) draft[event.resource] = event.text;
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
        const owned = abort.current === controller;
        // If the user moved on to something else, leave the screen alone.
        if (owned) {
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
        if (owned && extra?.avoid && started && !finished.has("quiz")) {
          // Keep the quiz they had rather than leaving them with none.
          draft.quiz = previousQuiz;
          setCurrent({ ...draft });
          setStates((prev) => ({ ...prev, quiz: { status: previousQuiz ? "done" : "idle" } }));
          if (!controller.signal.aborted) setNotice("A new quiz couldn't be written, so your current quiz is still here. Try again in a moment.");
        }
        // Save only what completed; half-written resources aren't kept.
        if (finished.size > 0) {
          const saved = { ...draft };
          for (const kind of resources) {
            if (finished.has(kind)) continue;
            if (kind === "quiz") saved.quiz = null;
            else if (kind === "cards") saved.cards = null;
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

  const openSet = (set: StudySet, startTab?: Tab) => {
    detach();
    setClassOpen(null);
    setCurrent(set);
    setStates(idleStates(set));
    setTab(startTab ?? (set.lesson ? "lesson" : set.review ? "review" : "quiz"));
    setMaterials([]);
    setWarnings([]);
    setPersonalized(false);
    setCanRetry(false);
    window.scrollTo({ top: 0 });
  };

  const leave = () => !generating || window.confirm("Your study set is still being written. Leave anyway?");

  const goHome = () => {
    if (!leave()) return;
    detach();
    setCurrent(null);
    setClassOpen(null);
    setError(null);
  };

  const openClass = (name: string) => {
    if (!leave()) return;
    detach();
    setCurrent(null);
    setClassOpen(name);
    window.scrollTo({ top: 0 });
  };

  /** Back from a study set goes to its class, if it has one. */
  const goBack = () => {
    const course = current?.course?.trim();
    if (current && course) openClass(course);
    else goHome();
  };

  const startOver = () => {
    goHome();
    setFiles([]);
    setText("");
    setOptionsState((o) => ({ ...o, focus: "", course: "" }));
  };

  const removeSet = (id: string) => updateLibrary(libraryRef.current.filter((s) => s.id !== id));

  const onQuizFinish = useCallback(
    (attempt: QuizAttempt, coveredAll: boolean) => {
      const set = currentRef.current;
      if (!set) return;
      const patch: Partial<StudySet> = { attempts: [...(set.attempts ?? []), attempt].slice(-50) };
      const best = set.bestScore;
      if (coveredAll && (!best || best.total !== attempt.total || attempt.points > best.points)) {
        patch.bestScore = { correct: attempt.correct, total: attempt.total, points: attempt.points };
      }
      patchSet(patch);
    },
    [patchSet],
  );

  const onAddToNotes = useCallback(
    (added: string) => {
      const existing = currentRef.current?.notes?.trimEnd();
      patchSet({ notes: `${existing ? `${existing}\n\n` : ""}${added}\n` });
    },
    [patchSet],
  );

  const newQuiz = (choice: NewQuizOptions) => {
    const set = currentRef.current;
    if (!set?.quiz || generating) return;
    // The original files aren't kept, so the lesson (or review) stands in as the material.
    const material = set.lesson || set.review;
    if (!material) {
      setNotice("This study set has no lesson or review to write new questions from.");
      return;
    }
    const avoid = [...new Set([...(set.pastQuestions ?? []), ...set.quiz.questions.map((q) => q.question)])].slice(-150);
    void generate(["quiz"], set, {
      text: material,
      avoid,
      quizLength: choice.length,
      difficulty: choice.difficulty,
      focusTopics: choice.focusTopics,
    });
  };

  /** Older study sets were made before flashcards existed. */
  const makeCards = () => {
    const set = currentRef.current;
    const material = set?.lesson || set?.review;
    if (!set || !material || generating) return;
    void generate(["cards"], set, { text: material });
  };

  const setClassNote = (name: string, value: string) => {
    const next = { ...classNotes, [name.toLowerCase()]: value };
    setClassNotes(next);
    if (!saveClassNotes(next)) setNotice("This browser's storage is full, so class notes weren't saved.");
  };

  const libraryRow = (set: StudySet) => (
    <li key={set.id}>
      <button className="library-item" onClick={() => openSet(set)}>
        <strong>{set.title}</strong>
        <span className="muted">
          {new Date(set.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          {set.quiz ? ` · ${set.quiz.questions.length} questions` : ""}
          {set.bestScore ? ` · best ${set.bestScore.correct}/${set.bestScore.total}` : ""}
          {set.notes?.trim() ? " · notes" : ""}
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
  );
  const unfiled = library.filter((s) => !s.course?.trim());
  const allAttempts = library.flatMap((s) => s.attempts ?? []);
  const stats = {
    attempts: allAttempts.length,
    average: allAttempts.length
      ? Math.round((allAttempts.reduce((n, a) => n + a.correct / a.total, 0) / allAttempts.length) * 100)
      : 0,
  };

  return (
    <>
      <header className="topbar">
        <button className="brand" onClick={goHome} aria-label="StudyKit home">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          StudyKit
        </button>
        {(current || classOpen) && (
          <div className="topbar-actions">
            {generating && (
              <button className="btn btn-small" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            )}
            <button className="btn btn-small" onClick={goBack}>
              Back
            </button>
            <button className="btn btn-small btn-primary" onClick={startOver}>
              New study set
            </button>
          </div>
        )}
      </header>

      <main className={current || classOpen ? "page page-study" : "page"}>
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
            onRetry={
              canRetry && !generating
                ? (kind) => (kind === "cards" && current.lesson ? makeCards() : void generate([kind], current))
                : undefined
            }
            onQuizFinish={onQuizFinish}
            onNewQuiz={generating ? undefined : newQuiz}
            onKnown={(known) => patchSet({ known })}
            onMakeCards={!generating && (current.lesson || current.review) ? makeCards : undefined}
            cardsProgress={cardsProgress}
            onAddToNotes={onAddToNotes}
            onNotes={(notes) => patchSet({ notes })}
            onCourse={(course) => patchSet({ course })}
            courses={courses}
          />
        ) : classOpen ? (
          <ClassView
            name={classOpen}
            sets={library.filter((s) => s.course?.trim().toLowerCase() === classOpen.toLowerCase())}
            notes={classNotes[classOpen.toLowerCase()] ?? ""}
            onNotes={(value) => setClassNote(classOpen, value)}
            onOpenSet={openSet}
            onNew={() => {
              setOptionsState((o) => ({ ...o, course: classOpen }));
              setClassOpen(null);
            }}
          />
        ) : (
          <div className="home">
            <div className="home-main">
              <div className="hero">
                <h1>
                  Turn any class material into a way to <em>learn it</em>.
                </h1>
                <p>
                  Upload notes, slides or readings, or pull them straight from Canvas. Everything below is written from
                  your material.
                </p>
                <div className="feature-row">
                  <div className="feature" style={{ "--c": "var(--lesson)" } as React.CSSProperties}>
                    <i>L</i>
                    <strong>Full lesson</strong>
                    <span>Every idea explained, with examples</span>
                  </div>
                  <div className="feature" style={{ "--c": "var(--review)" } as React.CSSProperties}>
                    <i>R</i>
                    <strong>Short review</strong>
                    <span>The essentials for the night before</span>
                  </div>
                  <div className="feature" style={{ "--c": "var(--cards)" } as React.CSSProperties}>
                    <i>F</i>
                    <strong>Flashcards</strong>
                    <span>Flip, sort, and track what you know</span>
                  </div>
                  <div className="feature" style={{ "--c": "var(--quiz)" } as React.CSSProperties}>
                    <i>Q</i>
                    <strong>Practice quiz</strong>
                    <span>Tap to answer, see why, try again</span>
                  </div>
                </div>
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
                courses={courses}
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
              {stats.attempts > 0 && (
                <div className="stat-row" aria-label="Your study stats">
                  <div>
                    <strong>{library.length}</strong>
                    <span>study sets</span>
                  </div>
                  <div>
                    <strong>{stats.attempts}</strong>
                    <span>quizzes taken</span>
                  </div>
                  <div>
                    <strong>{stats.average}%</strong>
                    <span>average score</span>
                  </div>
                </div>
              )}
              <h2>Your study sets</h2>
              {library.length === 0 ? (
                <p className="muted">Study sets you create are saved in this browser, grouped by class.</p>
              ) : (
                <ul>
                  {courses.map((name) => (
                    <Fragment key={name}>
                      <li className="lib-heading">
                        <button className="lib-class" onClick={() => openClass(name)}>
                          {name}
                          <span>Open class</span>
                        </button>
                      </li>
                      {library.filter((s) => s.course?.trim().toLowerCase() === name.toLowerCase()).map(libraryRow)}
                    </Fragment>
                  ))}
                  {unfiled.length > 0 && courses.length > 0 && (
                    <li className="lib-heading">
                      <span className="lib-class">No class yet</span>
                    </li>
                  )}
                  {unfiled.map(libraryRow)}
                </ul>
              )}
            </aside>
          </div>
        )}
      </main>
    </>
  );
}
