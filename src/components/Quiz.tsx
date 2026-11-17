"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Quiz as QuizData, QuizAttempt, QuizDifficulty, QuizQuestion } from "@/lib/types";
import { Markdown } from "./Markdown";

const LETTERS = ["A", "B", "C", "D"];
const LEVELS: { id: QuizQuestion["difficulty"]; label: string }[] = [
  { id: "recall", label: "Recall" },
  { id: "understanding", label: "Understanding" },
  { id: "application", label: "Application" },
];

export interface NewQuizOptions {
  length: number;
  difficulty: QuizDifficulty;
  focusTopics: string[];
}

interface PlayQuestion extends QuizQuestion {
  /** Options in display order, each remembering whether it is the right one. */
  tiles: { text: string; correct: boolean }[];
  /** Tiles removed by the 50/50 hint. */
  hidden: number[];
}

interface Answer {
  question: PlayQuestion;
  picked: number;
  correct: boolean;
  points: number;
  hinted: boolean;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function prepare(questions: QuizQuestion[]): PlayQuestion[] {
  return questions.map((q) => {
    const tiles = q.options.map((text, i) => ({ text, correct: i === q.correctIndex }));
    // True/False reads best in its natural order; everything else is shuffled
    // so the answer's position can't be memorized on a replay.
    return { ...q, tiles: tiles.length === 2 ? tiles : shuffle(tiles), hidden: [] };
  });
}

/** Adds up every attempt so far into per-topic totals: topic → [correct, asked]. */
export function topicTotals(attempts: QuizAttempt[]): [string, number, number][] {
  const totals = new Map<string, [number, number]>();
  for (const a of attempts) {
    for (const [topic, [c, n]] of Object.entries(a.topics)) {
      const t = totals.get(topic) ?? [0, 0];
      totals.set(topic, [t[0] + c, t[1] + n]);
    }
  }
  return [...totals].map(([topic, [c, n]]) => [topic, c, n] as [string, number, number]).sort((a, b) => a[1] / a[2] - b[1] / b[2]);
}

type Phase = "setup" | "question" | "feedback" | "results";

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            disabled={o.disabled}
            className={value === o.value ? "is-on" : ""}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Quiz({
  quiz,
  best,
  attempts,
  onFinish,
  onNewQuiz,
  onAddToNotes,
}: {
  quiz: QuizData;
  best?: { correct: number; total: number; points: number };
  attempts: QuizAttempt[];
  onFinish: (attempt: QuizAttempt, coveredAll: boolean) => void;
  /** Writes a completely new quiz on the same material. Absent when that isn't possible. */
  onNewQuiz?: (options: NewQuizOptions) => void;
  onAddToNotes?: (text: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("setup");
  // Setup choices
  const [mode, setMode] = useState<"practice" | "test">("practice");
  const [level, setLevel] = useState<"all" | QuizQuestion["difficulty"]>("all");
  const [offTopics, setOffTopics] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(0); // 0 = all that match
  const [mixOrder, setMixOrder] = useState(false);
  // A run
  const [questions, setQuestions] = useState<PlayQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [recorded, setRecorded] = useState(true);
  const [addedToNotes, setAddedToNotes] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // New-quiz choices
  const [newLength, setNewLength] = useState(quiz.questions.length);
  const [newDifficulty, setNewDifficulty] = useState<QuizDifficulty>("mixed");
  const [focusWeak, setFocusWeak] = useState(true);

  const nextButton = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const feedback = useRef<HTMLDivElement>(null);

  const topics = useMemo(() => [...new Set(quiz.questions.map((q) => q.topic))], [quiz]);
  const pool = useMemo(
    () => quiz.questions.filter((q) => (level === "all" || q.difficulty === level) && !offTopics.has(q.topic)),
    [quiz, level, offTopics],
  );
  const count = limit > 0 ? Math.min(limit, pool.length) : pool.length;
  const mastery = useMemo(() => topicTotals(attempts), [attempts]);
  const weakTopics = useMemo(() => mastery.filter(([, c, n]) => n >= 2 && c / n < 0.7).map(([t]) => t), [mastery]);

  const current = questions[index];
  const last = answers[answers.length - 1];
  const points = answers.reduce((n, a) => n + a.points, 0);

  const start = useCallback((source: QuizQuestion[], record: boolean) => {
    setQuestions(prepare(source));
    setIndex(0);
    setAnswers([]);
    setStreak(0);
    setBestStreak(0);
    setRecorded(record);
    setAddedToNotes(false);
    setShowAll(false);
    setPhase("question");
  }, []);

  const startFromSetup = () => {
    const ordered = mixOrder ? shuffle(pool) : pool;
    start(ordered.slice(0, count), true);
  };

  const finish = useCallback(
    (all: Answer[]) => {
      setPhase("results");
      if (!recorded) return;
      const byTopic: Record<string, [number, number]> = {};
      for (const a of all) {
        const t = (byTopic[a.question.topic] ??= [0, 0]);
        t[1]++;
        if (a.correct) t[0]++;
      }
      onFinish(
        {
          at: Date.now(),
          mode,
          correct: all.filter((a) => a.correct).length,
          total: all.length,
          points: all.reduce((n, a) => n + a.points, 0),
          topics: byTopic,
        },
        all.length === quiz.questions.length,
      );
    },
    [recorded, onFinish, mode, quiz.questions.length],
  );

  const answer = useCallback(
    (picked: number) => {
      if (phase !== "question" || !current || current.hidden.includes(picked)) return;
      const correct = current.tiles[picked].correct;
      const hinted = current.hidden.length > 0;
      const newStreak = correct ? streak + 1 : 0;
      // 1000 for a correct answer (half after a hint), plus a bonus for several in a row.
      const earned = correct ? (hinted ? 500 : 1000) + Math.min(newStreak - 1, 5) * 100 : 0;
      const all = [...answers, { question: current, picked, correct, points: earned, hinted }];
      setStreak(newStreak);
      setBestStreak((b) => Math.max(b, newStreak));
      setAnswers(all);
      if (mode === "practice") {
        setPhase("feedback");
      } else if (index + 1 < questions.length) {
        // Test mode: no feedback until the end.
        setIndex(index + 1);
      } else {
        finish(all);
      }
    },
    [phase, current, streak, answers, mode, index, questions.length, finish],
  );

  const next = useCallback(() => {
    if (phase !== "feedback") return;
    if (index + 1 < questions.length) {
      setIndex(index + 1);
      setPhase("question");
    } else {
      finish(answers);
    }
  }, [phase, index, questions.length, finish, answers]);

  const useHint = () => {
    if (!current || current.hidden.length || current.tiles.length < 4) return;
    const wrong = shuffle(current.tiles.map((t, i) => (t.correct ? -1 : i)).filter((i) => i >= 0)).slice(0, 2);
    setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, hidden: wrong } : q)));
  };

  // Keyboard: 1–4 or A–D to answer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || phase !== "question" || !current) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement | null)?.tagName ?? "")) return;
      const key = e.key.toUpperCase();
      const i = LETTERS.includes(key) ? LETTERS.indexOf(key) : Number(key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < current.tiles.length) {
        e.preventDefault();
        answer(i);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, current, answer]);

  // Keep the action on screen: the question when a new one appears, the explanation once it's answered.
  useEffect(() => {
    if (phase === "feedback") {
      nextButton.current?.focus({ preventScroll: true });
      feedback.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else if (phase === "question") {
      stage.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [phase, index]);

  // ---- Setup ---------------------------------------------------------------
  if (phase === "setup") {
    const levelCount = (id: QuizQuestion["difficulty"]) =>
      quiz.questions.filter((q) => q.difficulty === id && !offTopics.has(q.topic)).length;
    const recent = attempts.slice(-6);
    return (
      <div className="quiz-stage quiz-setup">
        <div className="quiz-card">
          <p className="eyebrow">Practice quiz</p>
          <h2>{quiz.title}</h2>
          <p className="muted">
            {quiz.questions.length} questions across {topics.length} topic{topics.length === 1 ? "" : "s"}. Tap an answer —
            no typing, no timer.
          </p>
          {best && (
            <p className="best-score">
              Best so far: {best.correct}/{best.total} · {best.points.toLocaleString()} pts
            </p>
          )}

          <div className="setup-grid">
            <Segmented
              label="Mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: "practice", label: "Practice" },
                { value: "test", label: "Test" },
              ]}
            />
            <Segmented
              label="How many"
              value={limit}
              onChange={setLimit}
              options={[
                { value: 0, label: `All ${pool.length}` },
                { value: 5, label: "5", disabled: pool.length <= 5 },
                { value: 10, label: "10", disabled: pool.length <= 10 },
              ]}
            />
          </div>
          <p className="muted small">
            {mode === "practice"
              ? "Practice: see why each answer is right as you go."
              : "Test: no feedback until the end, like the real thing."}
          </p>

          <Segmented
            label="Level"
            value={level}
            onChange={setLevel}
            options={[
              { value: "all", label: "All" },
              ...LEVELS.map((l) => ({ value: l.id, label: `${l.label} ${levelCount(l.id)}`, disabled: levelCount(l.id) === 0 })),
            ]}
          />

          {topics.length > 1 && (
            <div className="field">
              <span>
                Topics{" "}
                {weakTopics.length > 0 && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => setOffTopics(new Set(topics.filter((t) => !weakTopics.includes(t))))}
                  >
                    Only my weak topics
                  </button>
                )}
              </span>
              <div className="topic-chips">
                {topics.map((t) => {
                  const on = !offTopics.has(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      className={`chip${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      onClick={() =>
                        setOffTopics((prev) => {
                          const nextSet = new Set(prev);
                          if (on) nextSet.add(t);
                          else nextSet.delete(t);
                          return nextSet;
                        })
                      }
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label className="switch">
            <input type="checkbox" checked={mixOrder} onChange={(e) => setMixOrder(e.target.checked)} />
            <span>Mix up the question order (otherwise easier questions come first)</span>
          </label>

          <button className="btn btn-primary btn-large" disabled={count === 0} onClick={startFromSetup}>
            {count === 0 ? "No questions match" : `Start quiz · ${count} question${count === 1 ? "" : "s"}`}
          </button>
        </div>

        {attempts.length > 0 && (
          <div className="quiz-card progress-card">
            <p className="eyebrow">Your progress</p>
            <div className="attempt-bars" role="img" aria-label="Scores on your recent attempts">
              {recent.map((a) => {
                const pct = Math.round((a.correct / a.total) * 100);
                return (
                  <div className="attempt" key={a.at}>
                    <span className="attempt-pct">{pct}%</span>
                    <span className="attempt-bar">
                      <span style={{ height: `${Math.max(6, pct)}%` }} className={pct >= 80 ? "good" : pct >= 60 ? "ok" : "low"} />
                    </span>
                    <span className="attempt-date">
                      {new Date(a.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="muted small">
              {attempts.length} attempt{attempts.length === 1 ? "" : "s"} · average{" "}
              {Math.round((attempts.reduce((n, a) => n + a.correct / a.total, 0) / attempts.length) * 100)}%
            </p>
            {mastery.length > 0 && (
              <section className="topic-breakdown">
                <h3>How well you know each topic</h3>
                {mastery.map(([topic, c, n]) => (
                  <div className="topic-row" key={topic}>
                    <span className="topic-name">{topic}</span>
                    <span className="topic-bar" aria-hidden="true">
                      <span className={c / n >= 0.8 ? "good" : c / n >= 0.6 ? "ok" : "low"} style={{ width: `${(c / n) * 100}%` }} />
                    </span>
                    <span className="topic-score">
                      {c}/{n}
                    </span>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---- Results ---------------------------------------------------------------
  if (phase === "results") {
    const correct = answers.filter((a) => a.correct).length;
    const pct = Math.round((correct / answers.length) * 100);
    const missed = answers.filter((a) => !a.correct);
    const headline = pct === 100 ? "Perfect score!" : pct >= 80 ? "Great work!" : pct >= 60 ? "Getting there." : "Keep practicing.";
    const group = (key: (a: Answer) => string) => {
      const map = new Map<string, { correct: number; total: number }>();
      for (const a of answers) {
        const e = map.get(key(a)) ?? { correct: 0, total: 0 };
        e.total++;
        if (a.correct) e.correct++;
        map.set(key(a), e);
      }
      return [...map.entries()].sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total);
    };
    const byTopic = group((a) => a.question.topic);
    const byLevel = group((a) => LEVELS.find((l) => l.id === a.question.difficulty)!.label);
    // The attempt just finished is the last one recorded; compare with the one before.
    const previous = recorded ? attempts[attempts.length - 2] : undefined;
    const change = previous ? pct - Math.round((previous.correct / previous.total) * 100) : null;
    const missedTopics = [...new Set(missed.map((a) => a.question.topic))];
    const reviewList = showAll ? answers : missed;

    return (
      <div className="quiz-stage quiz-results">
        <div className="quiz-card">
          <p className="eyebrow">{recorded ? (mode === "test" ? "Test results" : "Results") : "Retry results"}</p>
          <h2>{headline}</h2>
          <div className="result-stats">
            <div>
              <strong>
                {correct}/{answers.length}
              </strong>
              <span>correct ({pct}%)</span>
            </div>
            <div>
              <strong>{points.toLocaleString()}</strong>
              <span>points</span>
            </div>
            <div>
              <strong>{bestStreak}</strong>
              <span>best streak</span>
            </div>
          </div>
          {change !== null && (
            <p className={`trend ${change > 0 ? "up" : change < 0 ? "down" : ""}`}>
              {change > 0 ? `Up ${change} points from your last attempt.` : change < 0 ? `Down ${-change} points from your last attempt.` : "Same score as your last attempt."}
            </p>
          )}

          {(byTopic.length > 1 || byLevel.length > 1) && (
            <div className="breakdowns">
              {byTopic.length > 1 && (
                <section className="topic-breakdown">
                  <h3>By topic</h3>
                  {byTopic.map(([name, s]) => (
                    <div className="topic-row" key={name}>
                      <span className="topic-name">{name}</span>
                      <span className="topic-bar" aria-hidden="true">
                        <span className={s.correct / s.total >= 0.8 ? "good" : s.correct / s.total >= 0.6 ? "ok" : "low"} style={{ width: `${(s.correct / s.total) * 100}%` }} />
                      </span>
                      <span className="topic-score">
                        {s.correct}/{s.total}
                      </span>
                    </div>
                  ))}
                </section>
              )}
              {byLevel.length > 1 && (
                <section className="topic-breakdown">
                  <h3>By level</h3>
                  {byLevel.map(([name, s]) => (
                    <div className="topic-row" key={name}>
                      <span className="topic-name">{name}</span>
                      <span className="topic-bar" aria-hidden="true">
                        <span className={s.correct / s.total >= 0.8 ? "good" : s.correct / s.total >= 0.6 ? "ok" : "low"} style={{ width: `${(s.correct / s.total) * 100}%` }} />
                      </span>
                      <span className="topic-score">
                        {s.correct}/{s.total}
                      </span>
                    </div>
                  ))}
                </section>
              )}
            </div>
          )}

          <div className="result-actions">
            {missed.length > 0 && (
              <button className="btn btn-primary" onClick={() => start(missed.map((a) => a.question), false)}>
                Retry the {missed.length} I missed
              </button>
            )}
            <button className={missed.length ? "btn" : "btn btn-primary"} onClick={() => setPhase("setup")}>
              Play again
            </button>
            {onAddToNotes && missed.length > 0 && (
              <button
                className="btn"
                disabled={addedToNotes}
                onClick={() => {
                  onAddToNotes(
                    `Missed on the quiz:\n\n${missed
                      .map((a) => {
                        const right = a.question.tiles.find((t) => t.correct)!.text;
                        return `Q: ${a.question.question}\nA: ${right}${a.question.explanation ? `\nWhy: ${a.question.explanation}` : ""}`;
                      })
                      .join("\n\n")}`,
                  );
                  setAddedToNotes(true);
                }}
              >
                {addedToNotes ? "Added to notes" : "Add missed to my notes"}
              </button>
            )}
          </div>
        </div>

        {onNewQuiz && (
          <div className="quiz-card new-quiz">
            <p className="eyebrow">Keep going</p>
            <h3>Get a new quiz with different questions</h3>
            <div className="setup-grid">
              <Segmented
                label="Questions"
                value={newLength}
                onChange={setNewLength}
                options={[...new Set([10, 15, 20, quiz.questions.length])].sort((a, b) => a - b).map((n) => ({ value: n, label: String(n) }))}
              />
              <Segmented
                label="Difficulty"
                value={newDifficulty}
                onChange={setNewDifficulty}
                options={[
                  { value: "easier", label: "Easier" },
                  { value: "mixed", label: "Mixed" },
                  { value: "harder", label: "Harder" },
                ]}
              />
            </div>
            {missedTopics.length > 0 && (
              <label className="switch">
                <input type="checkbox" checked={focusWeak} onChange={(e) => setFocusWeak(e.target.checked)} />
                <span>Focus on what I missed: {missedTopics.join(", ")}</span>
              </label>
            )}
            <button
              className="btn btn-primary"
              onClick={() =>
                onNewQuiz({ length: newLength, difficulty: newDifficulty, focusTopics: focusWeak ? missedTopics : [] })
              }
            >
              Write my new quiz
            </button>
          </div>
        )}

        <div className="quiz-card">
          <div className="review-head">
            <h3>{showAll ? "Every question" : "Review what you missed"}</h3>
            <button className="link" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show missed only" : "Show every question"}
            </button>
          </div>
          {reviewList.length === 0 && <p className="muted">Nothing missed. Nice.</p>}
          {reviewList.map((a, i) => (
            <article className={`missed-item${a.correct ? " was-right" : ""}`} key={i}>
              <div className="missed-q">
                <Markdown text={a.question.question} inline />
              </div>
              {!a.correct && (
                <p className="missed-line wrong">
                  <span>Your answer</span>
                  <Markdown text={a.question.tiles[a.picked].text} inline />
                </p>
              )}
              <p className="missed-line right">
                <span>{a.correct ? "You got it" : "Correct"}</span>
                <Markdown text={a.question.tiles.find((t) => t.correct)!.text} inline />
              </p>
              {a.question.explanation && (
                <div className="missed-why">
                  <Markdown text={a.question.explanation} />
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
    );
  }

  // ---- Playing ---------------------------------------------------------------
  const answered = phase === "feedback";
  return (
    <div className="quiz-stage quiz-play" ref={stage}>
      <div className="quiz-hud">
        <span>
          Question {index + 1} <span className="muted">of {questions.length}</span>
        </span>
        {mode === "practice" && streak >= 2 && <span className="streak">{streak} in a row</span>}
        {mode === "practice" ? <span className="score">{points.toLocaleString()} pts</span> : <span className="muted">Test mode</span>}
      </div>
      <div className="quiz-dots" aria-hidden="true">
        {questions.map((_, i) => {
          const a = answers[i];
          const state = !a ? (i === index ? "now" : "") : mode === "test" ? "done" : a.correct ? "right" : "wrong";
          return <span key={i} className={state} />;
        })}
      </div>

      <div className="quiz-question">
        <span className="topic-chip">
          {current.topic} · {LEVELS.find((l) => l.id === current.difficulty)!.label}
        </span>
        <h2>
          <Markdown text={current.question} inline />
        </h2>
      </div>

      <div className={`tiles tiles-${current.tiles.length}`}>
        {current.tiles.map((tile, i) => {
          const gone = current.hidden.includes(i);
          const state = !answered ? (gone ? " is-gone" : "") : tile.correct ? " is-correct" : last?.picked === i ? " is-wrong" : " is-dim";
          return (
            <button
              key={i}
              className={`tile tile-${i}${state}`}
              disabled={answered || gone}
              onClick={() => answer(i)}
              aria-label={`${LETTERS[i]}: ${tile.text}`}
            >
              <span className="tile-letter" aria-hidden="true">
                {answered && tile.correct ? "✓" : answered && last?.picked === i ? "✕" : LETTERS[i]}
              </span>
              <span className="tile-text">
                <Markdown text={tile.text} inline />
              </span>
            </button>
          );
        })}
      </div>

      {!answered && current.tiles.length === 4 && (
        <div className="quiz-tools">
          <button className="btn btn-small" disabled={current.hidden.length > 0} onClick={useHint}>
            {current.hidden.length ? "Two wrong answers removed" : "50/50: remove two wrong answers"}
          </button>
          <span className="muted small">Using it halves the points for this question.</span>
        </div>
      )}

      {answered && last && (
        <div ref={feedback} className={`feedback ${last.correct ? "good" : "bad"}`} role="status">
          <div className="feedback-head">
            <strong>{last.correct ? "Correct!" : "Not quite"}</strong>
            {last.correct && <span>+{last.points.toLocaleString()}</span>}
          </div>
          {current.explanation && (
            <div className="feedback-why">
              <Markdown text={current.explanation} />
            </div>
          )}
          <button ref={nextButton} className="btn btn-primary" onClick={next}>
            {index + 1 < questions.length ? "Next question" : "See results"}
          </button>
        </div>
      )}
    </div>
  );
}
