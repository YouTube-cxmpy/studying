"use client";

import { useRef, useState } from "react";
import { formatBytes, prepareFile } from "@/lib/client";
import type { QuizDifficulty, SessionInfo } from "@/lib/types";
import { CanvasPanel, type CanvasSelection } from "./CanvasPanel";

export interface CreateOptions {
  gradeLevel: string;
  quizLength: number;
  difficulty: QuizDifficulty;
  focus: string;
  /** Class this set is filed under. Blank falls back to the chosen Canvas course. */
  course: string;
}

const GRADE_LEVELS = [
  "Middle school",
  "High school",
  "9th grade",
  "10th grade",
  "11th grade",
  "12th grade",
  "AP / honors",
  "College",
];
const QUIZ_LENGTHS = [10, 15, 20, 30];
const ACCEPT = ".pdf,.docx,.pptx,.txt,.md,.csv,.html,.png,.jpg,.jpeg,.gif,.webp,application/pdf,image/*,text/*";
const MAX_UPLOAD_BYTES = 22 * 1024 * 1024;

export function Create({
  files,
  setFiles,
  text,
  setText,
  options,
  setOptions,
  session,
  refreshSession,
  canvas,
  setCanvas,
  onGenerate,
  error,
  courses,
}: {
  files: File[];
  setFiles: (update: (prev: File[]) => File[]) => void;
  text: string;
  setText: (text: string) => void;
  options: CreateOptions;
  setOptions: (options: CreateOptions) => void;
  session: SessionInfo;
  refreshSession: () => void;
  canvas: CanvasSelection | null;
  setCanvas: (selection: CanvasSelection | null) => void;
  onGenerate: () => void;
  error: string | null;
  courses: string[];
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [showPaste, setShowPaste] = useState(text.length > 0);
  const [showCanvas, setShowCanvas] = useState(session.canvas !== null);

  const addFiles = async (list: FileList | File[]) => {
    const prepared = await Promise.all(Array.from(list).map(prepareFile));
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...prepared.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  };

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const tooBig = totalBytes > MAX_UPLOAD_BYTES;
  const canvasCount = canvas?.refs.length ?? 0;
  const hasMaterial = files.length > 0 || text.trim().length > 0 || canvasCount > 0;
  const summary = [
    files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "",
    text.trim() ? "pasted notes" : "",
    canvasCount ? `${canvasCount} Canvas item${canvasCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean);

  return (
    <div className="create">
      <section className="card">
        <h2>
          <span className="step">1</span>Add your material
        </h2>

        <div
          className={`dropzone${dragging ? " is-dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void addFiles(e.dataTransfer.files);
          }}
        >
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <p className="dropzone-title">Drop files here</p>
          <p className="muted">PDFs, slides (.pptx), Word docs, text, or photos of notes and textbook pages</p>
          <button type="button" className="btn" onClick={() => input.current?.click()}>
            Choose files
          </button>
        </div>

        {files.length > 0 && (
          <ul className="file-list">
            {files.map((file, i) => (
              <li key={`${file.name}-${i}`}>
                <span className="file-name">{file.name}</span>
                <span className="muted">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {tooBig && (
          <p className="error-text">
            These files total {formatBytes(totalBytes)}; the limit is 22 MB per study set. Remove some or split them
            up.
          </p>
        )}

        <div className="source-toggles">
          <button type="button" className={`chip${showPaste ? " is-on" : ""}`} onClick={() => setShowPaste((v) => !v)}>
            Paste notes
          </button>
          <button
            type="button"
            className={`chip${showCanvas ? " is-on" : ""}`}
            onClick={() => setShowCanvas((v) => !v)}
          >
            {session.canvas ? "Import from Canvas" : "Connect Canvas"}
            {canvasCount > 0 && <b>{canvasCount}</b>}
          </button>
        </div>

        {showPaste && (
          <textarea
            className="paste"
            placeholder="Paste notes, a study guide, an article, or anything else you need to learn…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
          />
        )}

        {showCanvas && (
          <div className="canvas-panel">
            <CanvasPanel session={session} refreshSession={refreshSession} onChange={setCanvas} />
          </div>
        )}
      </section>

      <section className="card">
        <h2>
          <span className="step">2</span>Tune it
        </h2>
        <div className="options">
          <label className="field">
            <span>Level</span>
            <select value={options.gradeLevel} onChange={(e) => setOptions({ ...options, gradeLevel: e.target.value })}>
              {GRADE_LEVELS.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </label>
          <div className="field">
            <span id="quiz-length-label">Quiz length</span>
            <div className="segmented" role="radiogroup" aria-labelledby="quiz-length-label">
              {QUIZ_LENGTHS.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={options.quizLength === n}
                  className={options.quizLength === n ? "is-on" : ""}
                  onClick={() => setOptions({ ...options, quizLength: n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="field">
          <span id="quiz-difficulty-label">Quiz difficulty</span>
          <div className="segmented" role="radiogroup" aria-labelledby="quiz-difficulty-label">
            {(
              [
                ["easier", "Easier"],
                ["mixed", "Mixed"],
                ["harder", "Harder"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={options.difficulty === value}
                className={options.difficulty === value ? "is-on" : ""}
                onClick={() => setOptions({ ...options, difficulty: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>
            Class <span className="muted">(optional{canvas ? `, defaults to ${canvas.courseName}` : ""})</span>
          </span>
          <input
            type="text"
            list="course-names"
            maxLength={60}
            placeholder="e.g. Biology"
            value={options.course}
            onChange={(e) => setOptions({ ...options, course: e.target.value })}
          />
          <datalist id="course-names">
            {courses.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>
            Anything to focus on? <span className="muted">(optional)</span>
          </span>
          <input
            type="text"
            maxLength={600}
            placeholder="e.g. Unit test Friday — I'm shaky on the Krebs cycle"
            value={options.focus}
            onChange={(e) => setOptions({ ...options, focus: e.target.value })}
          />
        </label>
      </section>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="generate-row">
        <button className="btn btn-primary btn-large" disabled={!hasMaterial || tooBig} onClick={onGenerate}>
          Create my study set
        </button>
        <p className="muted">
          {hasMaterial
            ? `From ${summary.join(" + ")}: a full lesson, a short review, flashcards, and a ${options.quizLength}-question quiz.`
            : "Add a file, paste notes, or pick Canvas items to begin."}
        </p>
      </div>
    </div>
  );
}
