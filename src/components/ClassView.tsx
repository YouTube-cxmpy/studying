"use client";

import { useEffect, useRef, useState } from "react";
import type { StudySet } from "@/lib/types";

/** One class in one place: its study sets, class-wide notes, and the notes written inside each set. */
export function ClassView({
  name,
  sets,
  notes,
  onNotes,
  onOpenSet,
  onNew,
}: {
  name: string;
  sets: StudySet[];
  notes: string;
  onNotes: (notes: string) => void;
  onOpenSet: (set: StudySet, tab?: "notes") => void;
  onNew: () => void;
}) {
  const [value, setValue] = useState(notes);
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(notes);
  const save = useRef(onNotes);
  save.current = onNotes;

  const flush = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    save.current(latest.current);
    setStatus("Saved");
  };
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const ordered = [...sets].sort((a, b) => b.createdAt - a.createdAt);
  const noted = ordered.filter((s) => s.notes?.trim());

  return (
    <div className="class-view">
      <header className="study-head">
        <p className="eyebrow">Class</p>
        <h1>{name}</h1>
        <p className="muted">
          {sets.length} study set{sets.length === 1 ? "" : "s"}
        </p>
      </header>
      <div className="class-grid">
        <div className="class-col">
          <div className="notes-head">
            <h2>Study sets</h2>
            <button className="btn btn-small btn-primary" onClick={onNew}>
              New study set for this class
            </button>
          </div>
          {ordered.length === 0 && <p className="muted">No study sets in this class yet.</p>}
          {ordered.map((s) => (
            <button key={s.id} className="set-row" onClick={() => onOpenSet(s)}>
              <strong>{s.title}</strong>
              <span>
                {[
                  new Date(s.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
                  s.lesson ? "lesson" : "",
                  s.review ? "review" : "",
                  s.quiz ? `${s.quiz.questions.length}-question quiz` : "",
                  s.bestScore ? `best ${s.bestScore.correct}/${s.bestScore.total}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          ))}
        </div>
        <div className="class-col">
          <div className="notes-head">
            <h2>Class notes</h2>
            <span className="muted small" aria-live="polite">
              {status}
            </span>
          </div>
          <label className="field" htmlFor="class-notes">
            <span className="muted">Anything for the whole class: test dates, what the teacher stressed, things to ask.</span>
            <textarea
              id="class-notes"
              className="class-notes-box"
              value={value}
              placeholder="Write class notes here…"
              onBlur={flush}
              onChange={(e) => {
                latest.current = e.target.value;
                setValue(e.target.value);
                setStatus("Saving…");
                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(flush, 700);
              }}
            />
          </label>
          <div className="notes-head">
            <h2>Notes from your study sets</h2>
          </div>
          {noted.length === 0 && <p className="muted">Notes you write inside a study set show up here.</p>}
          {noted.map((s) => (
            <div className="note-card" key={s.id}>
              <button className="link" style={{ justifySelf: "start" }} onClick={() => onOpenSet(s, "notes")}>
                {s.title}
              </button>
              <pre>{s.notes!.trim()}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
