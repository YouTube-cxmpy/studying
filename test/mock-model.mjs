// A stand-in for the Anthropic Messages API that streams canned output, so the
// app can be exercised end to end without spending tokens. It records each
// request so tests can check what was actually sent.
//   node test/mock-model.mjs             → http://127.0.0.1:4011
import http from "node:http";

const PORT = Number(process.env.MOCK_MODEL_PORT ?? 4011);
export const requests = [];

const LESSON = `# Cell Membranes and Transport

This lesson covers how the cell membrane is built and how substances cross it.

## Membrane structure

The membrane is a **phospholipid bilayer**. The rate of diffusion follows $J = -D \\frac{dC}{dx}$.

| Transport | Energy | Example |
| --- | --- | --- |
| Diffusion | None | $O_2$ |
| Active transport | ATP | Na⁺/K⁺ pump |

**Check yourself**
1. Why is the bilayer's interior hydrophobic?

## Passive transport

Diffusion, osmosis and facilitated diffusion move substances down their gradient.

## Active transport

Pumps move solutes against the gradient using ATP.

## Key terms

| Term | Definition |
| --- | --- |
| Osmosis | Diffusion of water across a membrane |

## Summary

- Membranes are selectively permeable.

## Check yourself answers

1. Fatty acid tails are nonpolar.
`;

const REVIEW = `# Cell Membranes and Transport — Review

## The big picture

Membranes control what enters and leaves the cell.

## Must-know concepts

- **Fluid mosaic model**: proteins float in a phospholipid bilayer.
- **Osmosis**: water moves toward the higher solute concentration.

## If you only remember five things

1. Passive transport needs no ATP.
`;

const CARDS = {
  cards: [
    { topic: "Membrane structure", front: "Phospholipid bilayer", back: "Two layers of phospholipids with hydrophobic tails facing inward." },
    { topic: "Passive transport", front: "What is osmosis?", back: "Diffusion of water across a selectively permeable membrane." },
    { topic: "Active transport", front: "What powers the Na⁺/K⁺ pump?", back: "ATP." },
    { topic: "Passive transport", front: "Facilitated diffusion", back: "Passive movement through channel or carrier proteins." },
  ],
};

const topics = ["Membrane structure", "Passive transport", "Active transport"];
function quiz(count) {
  return {
    title: "Cell Membranes and Transport",
    questions: Array.from({ length: count }, (_, i) =>
      i % 5 === 4
        ? { topic: topics[i % 3], difficulty: "recall", question: `True or false (${i + 1}): osmosis requires ATP.`, options: ["True", "False"], correctIndex: 1, explanation: "Osmosis is passive transport." }
        : { topic: topics[i % 3], difficulty: "understanding", question: `Question ${i + 1}: which process moves water across a membrane? Rate is $J$.`, options: ["Osmosis", "Exocytosis", "Sodium pump", "Phagocytosis"], correctIndex: 0, explanation: "Osmosis is the diffusion of water; the others move other things." },
    ),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const instruction = body.messages[0].content.at(-1).text;
  const kind = /FLASHCARDS/.test(instruction) ? "cards" : body.output_config?.format ? "quiz" : /SHORT REVIEW/.test(instruction) ? "review" : "lesson";
  requests.push({ kind, body, beta: req.headers["anthropic-beta"], at: Date.now() });

  if (process.env.MOCK_MODEL_FAIL === kind) {
    res.writeHead(529, { "Content-Type": "application/json", "x-should-retry": "false" });
    res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    return;
  }

  const count = Number(/(\d+) multiple-choice/.exec(instruction)?.[1] ?? 10);
  const text = kind === "quiz" ? JSON.stringify(quiz(count)) : kind === "cards" ? JSON.stringify(CARDS) : kind === "review" ? REVIEW : LESSON;

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", {
    message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
  });
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (let i = 0; i < text.length; i += 40) {
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(i, i + 40) } });
    await sleep(Number(process.env.MOCK_MODEL_DELAY ?? 15));
  }
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 100 } });
  event("message_stop", {});
  res.end();
});

export function start() {
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await start();
  console.log(`mock model on http://127.0.0.1:${PORT}`);
}
