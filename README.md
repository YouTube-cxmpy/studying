# StudyKit

Upload any learning material and get four study resources built from it:

1. **Full lesson** – a complete, teacher-style lesson covering everything in the material, with worked examples, check-yourself questions, a glossary and a summary.
2. **Short review** – a two-page study guide: must-know concepts, key terms, formulas/dates, common mistakes, and a quick self-test.
3. **Flashcards** – one card per key term, formula and idea. Flip, mark "Got it" or "Still learning", and drill only the ones you don't know yet.
4. **Practice quiz** – tap one of four answer tiles (or press 1–4 / A–D), no timer.
   - Before you start: Practice mode (explanation after each answer) or Test mode (results at the end), how many questions, which level, which topics, and whether to mix the order.
   - While playing: a 50/50 hint that removes two wrong answers for half points, streaks, and a progress strip.
   - Afterwards: results by topic and by level, a comparison with your last attempt, a review of every question, "retry what I missed", and a **new quiz with different questions** where you pick the length, the difficulty, and whether to focus on what you missed.
   - Every attempt is saved, so the quiz screen shows your score history and how well you know each topic.

Each study set also has a **My notes** tab (with one-click "Add missed to my notes" from the quiz results) and can be filed under a **class**. A class page brings together its study sets, class-wide notes, and the notes from each set. Connecting Canvas files new sets under the Canvas course automatically, and shows how the class is going: current grade, what's coming up, low scores and missing work.

## Get the website version

The website is this repository (a Next.js app on branch `claude/blissful-lamport-yti9g9`). It is not hosted anywhere yet, so you run it yourself:

```bash
git clone https://github.com/YouTube-cxmpy/studying.git && cd studying
git checkout claude/blissful-lamport-yti9g9
npm install
cp .env.example .env.local      # add ANTHROPIC_API_KEY
npm run dev                     # open http://localhost:3000
```

To put it online for a tester, deploy it to any Node host (Render, Railway, Fly.io, a VPS) with `npm run build` / `npm start`, set `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `APP_ACCESS_CODE` and `APP_URL`, and use HTTPS. Avoid hosts that cap request bodies at a few MB (Vercel's limit is 4.5 MB), because uploads would fail.

## Run it

```bash
npm install
cp .env.example .env.local     # then add your ANTHROPIC_API_KEY
npm run dev                    # http://localhost:3000
```

Requires Node 20+. For a real deployment run `npm run build && npm start` and set `SESSION_SECRET` (and ideally `APP_ACCESS_CODE`, see below).

### Settings (`.env.local`)

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required. Used on the server only. |
| `SESSION_SECRET` | Recommended. Encrypts the Canvas session cookie (`openssl rand -hex 32`). If unset, a key derived from `ANTHROPIC_API_KEY` is used. |
| `APP_ACCESS_CODE` | Optional but recommended on the open internet: visitors must enter this code before the app will spend your API credits. |
| `STUDY_MODEL`, `STUDY_EFFORT` | Optional. Default `claude-opus-5-5` at `high` effort. |
| `CANVAS_OAUTH_BASE_URL`, `CANVAS_CLIENT_ID`, `CANVAS_CLIENT_SECRET`, `CANVAS_OAUTH_SCOPES`, `APP_URL` | Optional. Turns on "Sign in with Canvas". |

## What you can upload

| Type | How it is read |
| --- | --- |
| PDF | Sent to the model whole, so diagrams, tables, scans and handwriting are seen. |
| Photos / screenshots (PNG, JPEG, GIF, WebP) | Seen as images. Large phone photos are shrunk in the browser first. |
| Word (`.docx`), PowerPoint (`.pptx`, including speaker notes) | Text only. If the pictures matter, export to PDF. |
| Text, Markdown, CSV, HTML, pasted notes | As text. |

Limits per study set: 22 MB of PDFs and images, about 1.5 million characters of text, 40 files. Anything that can't be read is reported on screen, never silently dropped.

## Canvas

Canvas access is **read-only**: the app only issues `GET` requests to the Canvas API.

There are two ways to connect:

- **Access token (works today, good for one tester).** In Canvas: Account → Settings → Approved Integrations → *+ New Access Token*. Paste it into the app with the school's Canvas address (for example `myschool.instructure.com`). Some schools switch this button off for students; in that case use OAuth or plain uploads.
- **Sign in with Canvas (OAuth, the right way for many students).** A Canvas admin at the school creates a *Developer Key* (Admin → Developer Keys → + API Key) with redirect URI `<APP_URL>/api/canvas/oauth/callback`. Put the key's id and secret in the `CANVAS_*` variables. Students then just click "Sign in with Canvas" and approve. Instructure's API policy asks apps used by more than one person to use OAuth rather than collecting tokens, so plan on this before opening the app up.

What the app reads once connected: the student's active courses, and for the chosen course its modules, pages, files, syllabus, assignments, and the student's own submission scores.

What is sent to the AI model: only the items the student ticks, plus (if "Personalize" is on) a short summary of upcoming assignments and recent scores for that course. The student's name and Canvas ids are not sent. Canvas quizzes are never imported, and the model is told to use assignment descriptions for emphasis, not to complete them.

Where the credential lives: in an AES-256-GCM-encrypted, `httpOnly` cookie in the student's browser. Nothing about a student is stored on the server. "Disconnect" deletes the cookie; the student can also revoke the token or integration inside Canvas.

### Before you connect a student's account

The tester is a minor and Canvas holds education records, so get this in place first:

- The student's **and a parent/guardian's** agreement (the connect screen asks the student to confirm this).
- A check with the school. Many districts require approval before a third-party tool touches student data (FERPA, and state student-privacy laws), and OAuth needs the school's admin anyway.
- A privacy notice of your own before other students use it. This repository does not include one.

## How it works

```
browser ──multipart──▶ POST /api/generate ──▶ Claude (3 streamed requests)
   ▲                        │  ▲
   └──── NDJSON events ─────┘  └── Canvas API (pages, files, assignments) if selected
```

- `src/lib/extract.ts` turns each file into a PDF, image or text part.
- `src/lib/prompts.ts` holds the teaching instructions for the lesson, review and quiz.
- `src/lib/generate.ts` runs the three requests. They share one identical, cached prefix (system prompt + material); the lesson starts first and the other two start as soon as it begins streaming, so the material is read from the prompt cache rather than paid for three times. The quiz uses structured output (a JSON schema) and is validated before it reaches the browser.
- `src/lib/canvas.ts` is the Canvas client (pagination, string ids, OAuth refresh, download safety checks).
- `src/lib/session.ts` seals cookies. `src/lib/http.ts` gates every API route (access code + same-origin check).
- Study sets and quiz scores are saved in the browser's local storage, so there are no accounts or database yet.

### If Canvas won't connect

- Use the address you see in the browser while you're in Canvas (for example `myschool.instructure.com`). A school's own short address is followed automatically.
- "Canvas rejected the sign-in" means the token is wrong, expired or revoked: make a new one under Account → Settings → New Access Token.
- If the site is served over plain `http` on a non-localhost address, set `APP_URL` to that address so the sign-in cookie is accepted.
- Any other failure now shows the underlying reason in the message, and the server log has the full error.

## Tests

```bash
npm run test:e2e
```

Starts the app against two local stand-ins (`test/mock-canvas.mjs`, `test/mock-model.mjs`) and drives a real browser through the whole flow: OAuth and token sign-in, course import, upload, generation, the quiz, the saved library, error/retry, and the phone layout. It needs Playwright with Chromium available (`npm i -D playwright && npx playwright install chromium`). The mocks are also handy for UI work without spending API credits:

```bash
node test/mock-canvas.mjs &
node test/mock-model.mjs &
ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:4011 \
CANVAS_ALLOW_INSECURE_HOSTS=127.0.0.1:4010 npm run dev
# Canvas address: http://127.0.0.1:4010   token: test-token
```

## Deploying

- Any Node host works (`npm run build && npm start`). A long lesson can stream for several minutes, so the host must allow long-lived responses.
- Serverless platforms often cap request bodies at a few MB (Vercel: 4.5 MB), which will reject larger PDFs. Use a regular Node server or container if students will upload big files.
- Set `SESSION_SECRET`, serve over HTTPS, and set `APP_ACCESS_CODE` until you have real sign-in.

## Before opening it to many students

- Student accounts, with study sets stored server-side so they follow the student across devices.
- Per-student usage limits (each study set is three model requests over the full material).
- Canvas OAuth for each school (one Developer Key per Canvas instance), plus the privacy notice and school approvals above.
