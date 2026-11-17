"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Flashcard } from "@/lib/types";
import { Markdown } from "./Markdown";

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Flip-and-sort flashcards. Cards marked "Got it" are remembered and can be left out next time. */
export function Flashcards({
  cards,
  known,
  onKnown,
}: {
  cards: Flashcard[];
  known: string[];
  onKnown: (known: string[]) => void;
}) {
  const [onlyLearning, setOnlyLearning] = useState(false);
  const [deck, setDeck] = useState<Flashcard[]>(cards);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const knownSet = useMemo(() => new Set(known), [known]);

  const deal = useCallback(
    (learningOnly: boolean, mix: boolean) => {
      const pick = learningOnly ? cards.filter((c) => !knownSet.has(c.front)) : cards;
      setDeck(mix ? shuffle(pick) : pick);
      setIndex(0);
      setFlipped(false);
      setOnlyLearning(learningOnly);
    },
    [cards, knownSet],
  );

  const card = deck[index];
  const done = index >= deck.length;

  const go = useCallback(
    (step: number) => {
      setFlipped(false);
      setIndex((i) => Math.max(0, Math.min(deck.length, i + step)));
    },
    [deck.length],
  );

  const mark = useCallback(
    (gotIt: boolean) => {
      if (!card) return;
      const next = new Set(knownSet);
      if (gotIt) next.add(card.front);
      else next.delete(card.front);
      if (next.size !== knownSet.size) onKnown([...next]);
      go(1);
    },
    [card, knownSet, onKnown, go],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || done) return;
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test((e.target as HTMLElement | null)?.tagName ?? "") && e.key === " ") return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [done, go]);

  const knownCount = cards.filter((c) => knownSet.has(c.front)).length;
  const learning = cards.length - knownCount;

  return (
    <div className="cards-stage">
      <div className="cards-head">
        <div>
          <p className="eyebrow">Flashcards</p>
          <p className="muted">
            You know <strong>{knownCount}</strong> of {cards.length}
          </p>
        </div>
        <div className="cards-tools">
          <button className={`chip${onlyLearning ? "" : " is-on"}`} onClick={() => deal(false, false)}>
            All {cards.length}
          </button>
          <button className={`chip${onlyLearning ? " is-on" : ""}`} disabled={learning === 0} onClick={() => deal(true, false)}>
            Still learning {learning}
          </button>
          <button className="chip" onClick={() => deal(onlyLearning, true)}>
            Shuffle
          </button>
        </div>
      </div>
      <div className="cards-meter" aria-hidden="true">
        <span style={{ width: `${(knownCount / cards.length) * 100}%` }} />
      </div>

      {done ? (
        <div className="quiz-card cards-done">
          <h2>{learning === 0 ? "You know every card!" : "That's the deck."}</h2>
          <p className="muted">
            {learning === 0
              ? "Come back tomorrow and run them again to make it stick."
              : `${learning} card${learning === 1 ? "" : "s"} still to learn. Going through just those is the fastest way to finish.`}
          </p>
          <div className="result-actions">
            {learning > 0 && (
              <button className="btn btn-primary" onClick={() => deal(true, true)}>
                Practice the {learning} I&apos;m still learning
              </button>
            )}
            <button className={learning > 0 ? "btn" : "btn btn-primary"} onClick={() => deal(false, true)}>
              Go through all {cards.length} again
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            className={`flashcard${flipped ? " is-flipped" : ""}`}
            onClick={() => setFlipped((f) => !f)}
            aria-label={flipped ? "Showing the answer. Tap to see the question." : "Tap to see the answer."}
          >
            <span className="flashcard-meta">
              <span className="topic-chip">{card.topic}</span>
              <span className="muted small">
                {index + 1} / {deck.length}
                {knownSet.has(card.front) ? " · known" : ""}
              </span>
            </span>
            <span className="flashcard-body">
              <Markdown text={flipped ? card.back : card.front} inline />
            </span>
            <span className="flashcard-hint">{flipped ? "Answer" : "Tap to flip"}</span>
          </button>
          <div className="cards-actions">
            <button className="btn" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous card">
              ←
            </button>
            <button className="btn cards-again" onClick={() => mark(false)}>
              Still learning
            </button>
            <button className="btn cards-got" onClick={() => mark(true)}>
              Got it
            </button>
            <button className="btn" onClick={() => go(1)} aria-label="Skip card">
              →
            </button>
          </div>
          <p className="muted small cards-keys">Space flips the card. Arrow keys move between cards.</p>
        </>
      )}
    </div>
  );
}
