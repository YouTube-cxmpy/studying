"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Quiz as QuizData, QuizQuestion } from "@/lib/types";
import { Markdown } from "./Markdown";

const LETTERS = ["A", "B", "C", "D"];

interface PlayQuestion extends QuizQuestion {
  /** Options in display order, each remembering whether it is the right one. */
  tiles: { text: string; correct: boolean }[];
}

interface Answer {
  question: PlayQuestion;
  /** Index into tiles. */
  picked: number;
  correct: boolean;
  points: number;
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
    return { ...q, tiles: tiles.length === 2 ? tiles : shuffle(tiles) };
  });
}

type Phase = "intro" | "question" | "feedback" | "results";

export function Quiz({
  quiz,
  best,
  onFinish,
  onNewQuiz,
  onAddToNotes,
}: {
  quiz: QuizData;
  best?: { correct: number; total: number; points: number };
  onFinish: (result: { correct: number; total: number; points: number }) => void;
  /** Writes a completely new quiz on the same material. Absent when that isn't possible. */
  onNewQuiz?: () => void;
  onAddToNotes?: (text: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [addedToNotes, setAddedToNotes] = useState(false);
  const [questions, setQuestions] = useState<PlayQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [fullRun, setFullRun] = useState(true);
  const nextButton = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const feedback = useRef<HTMLDivElement>(null);

  const current = questions[index];
  const last = answers[answers.length - 1];
  const points = answers.reduce((n, a) => n + a.points, 0);

  const start = useCallback(
    (source: QuizQuestion[], isFullRun: boolean) => {
      setQuestions(prepare(source));
      setIndex(0);
      setAnswers([]);
      setStreak(0);
      setBestStreak(0);
      setFullRun(isFullRun);
      setAddedToNotes(false);
      setPhase("question");
    },
    [],
  );

  const answer = useCallback(
    (picked: number) => {
      if (phase !== "question" || !current) return;
      const correct = current.tiles[picked].correct;
      const newStreak = correct ? streak + 1 : 0;
      // 1000 for a correct answer, plus a bonus for answering several in a row.
      const earned = correct ? 1000 + Math.min(newStreak - 1, 5) * 100 : 0;
      setStreak(newStreak);
      setBestStreak((b) => Math.max(b, newStreak));
      setAnswers((a) => [...a, { question: current, picked, correct, points: earned }]);
      setPhase("feedback");
    },
    [phase, current, streak],
  );

  const next = useCallback(() => {
    if (phase !== "feedback") return;
    if (index + 1 < questions.length) {
      setIndex(index + 1);
      setPhase("question");
    } else {
      setPhase("results");
      if (fullRun) {
        onFinish({ correct: answers.filter((a) => a.correct).length, total: answers.length, points });
      }
    }
  }, [phase, index, questions.length, fullRun, onFinish, answers, points]);

  // Keyboard: 1–4 or A–D to answer, Enter for next.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (phase === "question" && current) {
        const key = e.key.toUpperCase();
        const i = LETTERS.includes(key) ? LETTERS.indexOf(key) : Number(key) - 1;
        if (Number.isInteger(i) && i >= 0 && i < current.tiles.length) {
          e.preventDefault();
          answer(i);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, current, answer]);

  // Keep the action on screen: the question when a new one appears, the
  // explanation once it's answered.
  useEffect(() => {
    if (phase === "feedback") {
      nextButton.current?.focus({ preventScroll: true });
      feedback.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else if (phase === "question") {
      stage.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [phase, index]);

  const byTopic = useMemo(() => {
    const map = new Map<string, { correct: number; total: number }>();
    for (const a of answers) {
      const entry = map.get(a.question.topic) ?? { correct: 0, total: 0 };
      entry.total++;
      if (a.correct) entry.correct++;
      map.set(a.question.topic, entry);
    }
    return [...map.entries()].sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total);
  }, [answers]);

  if (phase === "intro") {
    return (
      <div className="quiz-stage quiz-intro">
        <p className="eyebrow">Practice quiz</p>
        <h2>{quiz.title}</h2>
        <p className="muted">
          {quiz.questions.length} questions. Tap an answer — no typing, no timer. You&apos;ll see why each answer is
          right as you go.
        </p>
        {best && (
          <p className="best-score">
            Best so far: {best.correct}/{best.total} · {best.points.toLocaleString()} pts
          </p>
        )}
        <button className="btn btn-primary btn-large" onClick={() => start(quiz.questions, true)}>
          Start quiz
        </button>
      </div>
    );
  }

  if (phase === "results") {
    const correct = answers.filter((a) => a.correct).length;
    const pct = Math.round((correct / answers.length) * 100);
    const missed = answers.filter((a) => !a.correct);
    const headline = pct === 100 ? "Perfect score!" : pct >= 80 ? "Great work!" : pct >= 60 ? "Getting there." : "Keep practicing.";
    return (
      <div className="quiz-stage quiz-results">
        <p className="eyebrow">{fullRun ? "Results" : "Retry results"}</p>
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

        {byTopic.length > 1 && (
          <section className="topic-breakdown">
            <h3>By topic</h3>
            {byTopic.map(([topic, s]) => (
              <div className="topic-row" key={topic}>
                <span className="topic-name">{topic}</span>
                <span className="topic-bar" aria-hidden="true">
                  <span style={{ width: `${(s.correct / s.total) * 100}%` }} />
                </span>
                <span className="topic-score">
                  {s.correct}/{s.total}
                </span>
              </div>
            ))}
          </section>
        )}

        <div className="result-actions">
          {missed.length > 0 && (
            <button className="btn btn-primary" onClick={() => start(missed.map((a) => a.question), false)}>
              Retry the {missed.length} I missed
            </button>
          )}
          <button className={missed.length ? "btn" : "btn btn-primary"} onClick={() => start(quiz.questions, true)}>
            Play again
          </button>
          {onNewQuiz && (
            <button className="btn" onClick={onNewQuiz}>
              New quiz, different questions
            </button>
          )}
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

        {missed.length > 0 && (
          <section className="missed">
            <h3>Review what you missed</h3>
            {missed.map((a, i) => (
              <article className="missed-item" key={i}>
                <div className="missed-q">
                  <Markdown text={a.question.question} inline />
                </div>
                <p className="missed-line wrong">
                  <span>Your answer</span>
                  <Markdown text={a.question.tiles[a.picked].text} inline />
                </p>
                <p className="missed-line right">
                  <span>Correct</span>
                  <Markdown text={a.question.tiles.find((t) => t.correct)!.text} inline />
                </p>
                {a.question.explanation && (
                  <div className="missed-why">
                    <Markdown text={a.question.explanation} />
                  </div>
                )}
              </article>
            ))}
          </section>
        )}
      </div>
    );
  }

  const answered = phase === "feedback";
  return (
    <div className="quiz-stage quiz-play" ref={stage}>
      <div className="quiz-hud">
        <span>
          Question {index + 1} <span className="muted">of {questions.length}</span>
        </span>
        {streak >= 2 && <span className="streak">{streak} in a row</span>}
        <span className="score">{points.toLocaleString()} pts</span>
      </div>
      <div className="quiz-progress" aria-hidden="true">
        <span style={{ width: `${((index + (answered ? 1 : 0)) / questions.length) * 100}%` }} />
      </div>

      <div className="quiz-question">
        <span className="topic-chip">{current.topic}</span>
        <h2>
          <Markdown text={current.question} inline />
        </h2>
      </div>

      <div className={`tiles tiles-${current.tiles.length}`}>
        {current.tiles.map((tile, i) => {
          const state = !answered
            ? ""
            : tile.correct
              ? " is-correct"
              : last?.picked === i
                ? " is-wrong"
                : " is-dim";
          return (
            <button
              key={i}
              className={`tile tile-${i}${state}`}
              disabled={answered}
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
