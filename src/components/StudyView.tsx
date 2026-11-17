"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { downloadText, slugify } from "@/lib/client";
import type { MaterialSummary, QuizAttempt, ResourceKind, StudySet } from "@/lib/types";
import { Flashcards } from "./Flashcards";
import { Markdown, headingsOf, hideOpenFigure } from "./Markdown";
import { type NewQuizOptions, Quiz } from "./Quiz";

export type Tab = ResourceKind | "notes";
export type Status = "idle" | "waiting" | "streaming" | "done" | "error";
export type ResourceStates = Record<ResourceKind, { status: Status; error?: string; truncated?: boolean }>;

const TABS: { kind: Tab; label: string; short: string; blurb: string }[] = [
  { kind: "lesson", label: "Full lesson", short: "Lesson", blurb: "Everything, explained" },
  { kind: "review", label: "Short review", short: "Review", blurb: "The essentials" },
  { kind: "cards", label: "Flashcards", short: "Cards", blurb: "Quick recall" },
  { kind: "quiz", label: "Practice quiz", short: "Quiz", blurb: "Test yourself" },
  { kind: "notes", label: "My notes", short: "Notes", blurb: "In your own words" },
];

function StatusDot({ status }: { status: Status }) {
  if (status === "waiting" || status === "streaming") return <span className="dot dot-busy" aria-label="generating" />;
  if (status === "error") return <span className="dot dot-error" aria-label="failed" />;
  if (status === "done") return <span className="dot dot-done" aria-label="ready" />;
  return null;
}

function Waiting({ label }: { label: string }) {
  return (
    <div className="waiting">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
      <p className="muted">Reading everything carefully takes a minute or two. You can switch tabs while it works.</p>
    </div>
  );
}

function Failed({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="failed" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : (
        <p className="muted">Start a new study set with the same material to try again.</p>
      )}
    </div>
  );
}

function Document({
  kind,
  text,
  state,
  title,
  onRetry,
}: {
  kind: "lesson" | "review";
  text: string;
  state: ResourceStates[ResourceKind];
  title: string;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const headings = useMemo(() => (kind === "lesson" ? headingsOf(text) : []), [kind, text]);

  if (state.status === "error" && !text) return <Failed message={state.error ?? "Generation failed."} onRetry={onRetry} />;
  if (!text) {
    return state.status === "idle" ? (
      <p className="muted empty">This study set doesn&apos;t include a {kind}.</p>
    ) : (
      <Waiting label={kind === "lesson" ? "Writing your full lesson…" : "Writing your short review…"} />
    );
  }

  const copy = async () => {
    await navigator.clipboard.writeText(text).catch(() => null);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`document-layout${headings.length > 2 ? " has-toc" : ""}`}>
      {headings.length > 2 && (
        <nav className="toc" aria-label="Lesson sections">
          <p>In this lesson</p>
          <ol>
            {headings.map((h, i) => (
              <li key={`${h.id}-${i}`}>
                <a href={`#${h.id}`}>{h.title}</a>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="document-main">
        {state.status === "done" && (
          <div className="doc-actions">
            <button className="btn btn-small" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button className="btn btn-small" onClick={() => downloadText(`${slugify(title)}-${kind}.md`, text)}>
              Download
            </button>
            <button className="btn btn-small" onClick={() => window.print()}>
              Print
            </button>
          </div>
        )}
        <article className={`prose prose-${kind}`}>
          <Markdown text={state.status === "streaming" ? hideOpenFigure(text) : text} />
          {state.status === "streaming" && <span className="caret" aria-hidden="true" />}
        </article>
        {state.truncated && (
          <p className="notice">This {kind} hit the length limit and stops early. Split the material into smaller sets for full coverage.</p>
        )}
        {state.status === "error" && <Failed message={state.error ?? "Generation stopped early."} onRetry={onRetry} />}
      </div>
    </div>
  );
}

/** The notes box keeps its own text while typing and saves a moment after the last keystroke. */
function Notes({ set, onChange }: { set: StudySet; onChange: (notes: string) => void }) {
  const [value, setValue] = useState(set.notes ?? "");
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  const focused = useRef(false);
  const save = useRef(onChange);
  save.current = onChange;

  // Notes added from outside (e.g. missed quiz questions) appear unless the student is mid-edit.
  useEffect(() => {
    if (!focused.current && (set.notes ?? "") !== latest.current) {
      latest.current = set.notes ?? "";
      setValue(latest.current);
    }
  }, [set.notes]);

  const flush = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    save.current(latest.current);
    setStatus("Saved");
  };
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="notes-wrap">
      <div className="notes-head">
        <h2>My notes</h2>
        <span className="muted small" aria-live="polite">
          {status}
        </span>
      </div>
      <label className="field" htmlFor="set-notes">
        <span className="muted">
          Saved with this study set. If the set is in a class, these notes also show on the class page.
        </span>
        <textarea
          id="set-notes"
          value={value}
          placeholder="Write what you want to remember in your own words: tricky ideas, mnemonics, questions for your teacher…"
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            flush();
          }}
          onChange={(e) => {
            latest.current = e.target.value;
            setValue(e.target.value);
            setStatus("Saving…");
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(flush, 700);
          }}
        />
      </label>
    </div>
  );
}

export function StudyView({
  set,
  states,
  quizProgress,
  quizChecking,
  quizLength,
  materials,
  warnings,
  personalized,
  tab,
  setTab,
  onRetry,
  onQuizFinish,
  onNewQuiz,
  onKnown,
  onMakeCards,
  cardsProgress,
  onAddToNotes,
  onNotes,
  onCourse,
  courses,
}: {
  set: StudySet;
  states: ResourceStates;
  quizProgress: number;
  quizChecking: boolean;
  quizLength: number;
  materials: MaterialSummary[];
  warnings: string[];
  personalized: boolean;
  tab: Tab;
  setTab: (tab: Tab) => void;
  onRetry?: (kind: ResourceKind) => void;
  onQuizFinish: (attempt: QuizAttempt, coveredAll: boolean) => void;
  onNewQuiz?: (options: NewQuizOptions) => void;
  onKnown: (known: string[]) => void;
  /** Writes flashcards for an older set that has none. */
  onMakeCards?: () => void;
  cardsProgress: number;
  onAddToNotes: (text: string) => void;
  onNotes: (notes: string) => void;
  onCourse: (course: string) => void;
  courses: string[];
}) {
  const retry = (kind: ResourceKind) => (onRetry ? () => onRetry(kind) : undefined);

  return (
    <div className="study">
      <header className="study-head">
        <h1>{set.title}</h1>
        <p className="muted">
          {set.sources.length > 0 && <>From {set.sources.slice(0, 4).join(", ")}{set.sources.length > 4 ? ` and ${set.sources.length - 4} more` : ""}</>}
          {personalized && <span className="badge">Personalized from Canvas</span>}
        </p>
        <label className="class-pick">
          Class
          <input
            type="text"
            list="course-names"
            maxLength={60}
            placeholder="Add to a class"
            defaultValue={set.course ?? ""}
            key={set.id}
            onBlur={(e) => e.target.value.trim() !== (set.course ?? "") && onCourse(e.target.value.trim())}
          />
          <datalist id="course-names">
            {courses.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        {materials.some((m) => m.as === "text" && /\.(pptx|docx)$/i.test(m.name)) && (
          <p className="muted small">
            Slides and Word files are read as text only. If diagrams or images matter, export to PDF and add that
            instead.
          </p>
        )}
        {warnings.map((w, i) => (
          <p className="notice" key={i}>
            {w}
          </p>
        ))}
      </header>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.kind}
            role="tab"
            aria-selected={tab === t.kind}
            aria-label={t.label}
            className={tab === t.kind ? "is-on" : ""}
            onClick={() => setTab(t.kind)}
          >
            <span className="tab-label">
              <span className="tab-long">{t.label}</span>
              <span className="tab-short">{t.short}</span>
              {t.kind !== "notes" && <StatusDot status={states[t.kind].status} />}
            </span>
            <span className="tab-blurb">{t.blurb}</span>
          </button>
        ))}
      </div>

      <div className="tab-panel" role="tabpanel">
        {tab === "lesson" && (
          <Document kind="lesson" text={set.lesson} state={states.lesson} title={set.title} onRetry={retry("lesson")} />
        )}
        {tab === "review" && (
          <Document kind="review" text={set.review} state={states.review} title={set.title} onRetry={retry("review")} />
        )}
        {tab === "cards" &&
          (set.cards?.length ? (
            <Flashcards key={set.id} cards={set.cards} known={set.known ?? []} onKnown={onKnown} />
          ) : states.cards.status === "error" ? (
            <Failed message={states.cards.error ?? "The flashcards couldn't be generated."} onRetry={retry("cards")} />
          ) : states.cards.status === "idle" ? (
            <div className="empty">
              <p className="muted">This study set doesn&apos;t have flashcards yet.</p>
              {onMakeCards && (
                <button className="btn btn-primary" onClick={onMakeCards}>
                  Make flashcards
                </button>
              )}
            </div>
          ) : (
            <Waiting label={cardsProgress > 0 ? `Writing your flashcards… ${cardsProgress} so far` : "Writing your flashcards…"} />
          ))}
        {tab === "quiz" &&
          (set.quiz ? (
            <Quiz
              key={`${set.id}:${set.pastQuestions?.length ?? 0}`}
              quiz={set.quiz}
              best={set.bestScore}
              attempts={set.attempts ?? []}
              onFinish={onQuizFinish}
              onNewQuiz={onNewQuiz}
              onAddToNotes={onAddToNotes}
            />
          ) : states.quiz.status === "error" ? (
            <Failed message={states.quiz.error ?? "The quiz couldn't be generated."} onRetry={retry("quiz")} />
          ) : states.quiz.status === "idle" ? (
            <p className="muted empty">This study set doesn&apos;t include a quiz.</p>
          ) : (
            <Waiting
              label={
                quizChecking
                  ? "Checking every answer with a second, independent solve…"
                  : quizProgress > 0
                  ? `Writing your quiz… ${Math.min(quizProgress, quizLength)} of ${quizLength} questions`
                  : "Writing your quiz…"
              }
            />
          ))}
        {tab === "notes" && <Notes key={set.id} set={set} onChange={onNotes} />}
      </div>
    </div>
  );
}
