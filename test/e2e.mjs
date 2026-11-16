// End-to-end check: real Next server + real browser, against the mock Canvas
// and mock model servers. Run with: npm run test:e2e
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { requests, start as startModel } from "./mock-model.mjs";

// Playwright is resolved the CommonJS way so a globally installed copy works too.
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const JSZip = require("jszip");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const out = path.join(here, ".out");
fs.mkdirSync(out, { recursive: true });
const APP = "http://127.0.0.1:3100";
const shots = process.env.E2E_SHOTS === "1";

const children = [];
function run(cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(d));
  child.stderr.on("data", (d) => process.stderr.write(d));
  children.push(child);
  return child;
}
async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} never came up`);
}
const step = (name) => console.log(`  ✓ ${name}`);

let browser;
try {
  await startModel();
  run("node", ["test/mock-canvas.mjs"]);
  run("npx", ["next", "dev", "-p", "3100", "-H", "127.0.0.1"], {
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4011",
    CANVAS_ALLOW_INSECURE_HOSTS: "127.0.0.1:4010",
    SESSION_SECRET: "e2e-secret",
    CANVAS_OAUTH_BASE_URL: "http://127.0.0.1:4010",
    CANVAS_CLIENT_ID: "oauth-client",
    CANVAS_CLIENT_SECRET: "oauth-secret",
    APP_URL: APP,
    NEXT_TELEMETRY_DISABLED: "1",
  });
  await waitFor(`${APP}/api/session`);

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: shots ? 2 : 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/401|400/.test(m.text()) && errors.push(m.text()));

  await page.goto(APP);
  await page.getByRole("heading", { name: /Turn any class material/ }).waitFor();
  const generate = page.getByRole("button", { name: "Create my study set" });
  assert.equal(await generate.isDisabled(), true, "generate is disabled with no material");
  if (shots) await page.screenshot({ path: path.join(out, "01-home.png") });
  step("home renders");

  // --- Canvas via OAuth ("Sign in with Canvas") ---------------------------------------
  await page.getByRole("button", { name: "Connect Canvas" }).click();
  const signIn = page.getByRole("button", { name: /Sign in with Canvas/ });
  assert.equal(await signIn.isDisabled(), true, "sign-in is disabled until consent is given");
  await page.getByText("This is my own Canvas account").click();
  await signIn.click();
  await page.getByText("Connected as").waitFor();
  await page.locator("option", { hasText: "World History" }).waitFor({ state: "attached" });
  const grants = await (await fetch("http://127.0.0.1:4010/__stats")).json();
  assert.deepEqual(grants, { authorization_code: 1, refresh_token: 1 }, "code exchanged, then the expiring token refreshed");
  assert.equal(new URL(page.url()).search, "", "OAuth result is cleared from the address bar");
  await page.getByRole("button", { name: "Disconnect" }).click();
  step("OAuth sign-in, token refresh, disconnect");

  // --- Canvas via access token: bad address, bad token, then a good connection ----------
  await page.getByRole("button", { name: "Use an access token instead" }).click();
  await page.getByText("This is my own Canvas account").click();
  await page.getByPlaceholder("myschool.instructure.com").fill("http://169.254.169.254");
  await page.getByPlaceholder("Paste the token from Canvas").fill("x");
  await page.getByRole("button", { name: "Connect Canvas" }).last().click();
  await page.getByText("must use https").waitFor();
  step("internal addresses are refused");

  await page.getByPlaceholder("myschool.instructure.com").fill("http://127.0.0.1:4010/courses/1");
  await page.getByPlaceholder("Paste the token from Canvas").fill("wrong");
  await page.getByRole("button", { name: "Connect Canvas" }).last().click();
  await page.getByText("Canvas rejected the sign-in").waitFor();
  step("bad token is rejected");

  await page.getByPlaceholder("Paste the token from Canvas").fill("test-token");
  await page.getByRole("button", { name: "Connect Canvas" }).last().click();
  await page.getByText("Connected as").waitFor();
  const cookies = await context.cookies();
  const sessionCookie = cookies.find((c) => c.name === "sk_canvas");
  assert.ok(sessionCookie?.httpOnly, "session cookie is httpOnly");
  assert.ok(!sessionCookie.value.includes("test-token"), "token is not readable in the cookie");
  step("connects; token is sealed in an httpOnly cookie");

  // --- Course picker -----------------------------------------------------------------
  const courseSelect = page.locator("select").first();
  await page.locator("option", { hasText: "World History" }).waitFor({ state: "attached" });
  const optionTexts = await courseSelect.locator("option").allTextContents();
  assert.deepEqual(optionTexts.slice(1), ["Biology 1 — Period 3", "World History"], "paginated, restricted course hidden");
  await courseSelect.selectOption({ label: "Biology 1 — Period 3" });
  await page.getByText("Pick what to study from").waitFor();
  await page.getByText("Your school hides files").waitFor();
  await page.getByText("Unit 4 Test: Cells & Transport").first().waitFor();
  assert.equal(await page.getByRole("checkbox", { name: /Unit 4 Test/ }).isDisabled(), true, "quizzes can't be imported");
  await page.getByRole("checkbox", { name: /page\s*Cell Membrane Notes/ }).first().check();
  await page.getByRole("checkbox", { name: /Transport Summary/ }).check();
  await page.getByText("Unit 5: Energy").waitFor(); // module whose items were fetched separately
  if (shots) await page.screenshot({ path: path.join(out, "02-canvas.png"), fullPage: true });
  step("course overview lists modules, hides what the student can't access");

  // --- Upload + paste ------------------------------------------------------------------
  await page.locator('input[type="file"]').setInputFiles([
    { name: "my notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\nFacilitated diffusion uses channel proteins.") },
    { name: "movie.mp4", mimeType: "video/mp4", buffer: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]) },
  ]);
  await page.getByRole("button", { name: "Paste notes" }).click();
  await page.getByPlaceholder(/Paste notes, a study guide/).fill("Tonicity: hypotonic, isotonic, hypertonic.");
  await page.getByRole("radio", { name: "10" }).click();
  await page.getByPlaceholder(/Unit test Friday/).fill("Unit 4 test on Friday");
  await generate.click();

  // --- Study view --------------------------------------------------------------------------
  await page.getByRole("heading", { level: 1, name: "Cell Membranes and Transport" }).first().waitFor({ timeout: 60_000 });
  await page.getByText("Personalized from Canvas").waitFor();
  await page.getByText('"movie.mp4" isn\'t a supported file type').waitFor();
  await page.getByRole("button", { name: "Download" }).waitFor({ timeout: 60_000 });
  assert.ok((await page.locator(".prose .katex").count()) > 0, "math renders");
  assert.ok((await page.locator(".prose table").count()) > 0, "tables render");
  assert.equal(await page.locator(".toc a").count(), 6, "table of contents lists the sections");
  if (shots) await page.screenshot({ path: path.join(out, "03-lesson.png") });
  step("lesson streams in and renders (math, tables, contents)");

  await page.getByRole("tab", { name: /Short review/ }).click();
  await page.getByRole("heading", { name: "The big picture" }).waitFor();
  if (shots) await page.screenshot({ path: path.join(out, "04-review.png") });
  step("review renders");

  // --- What was sent to the model -----------------------------------------------------------
  assert.equal(requests.length, 3, "three model requests");
  const byKind = Object.fromEntries(requests.map((r) => [r.kind, r]));
  assert.deepEqual(Object.keys(byKind).sort(), ["lesson", "quiz", "review"]);
  assert.ok(byKind.lesson.at <= byKind.review.at && byKind.lesson.at <= byKind.quiz.at, "lesson goes first to warm the cache");
  const shared = (r) => JSON.stringify(r.body.messages[0].content.slice(0, -1));
  assert.equal(shared(byKind.lesson), shared(byKind.review), "shared prefix is byte-identical (lesson/review)");
  assert.equal(shared(byKind.lesson), shared(byKind.quiz), "shared prefix is byte-identical (lesson/quiz)");
  const sent = shared(byKind.lesson);
  assert.ok(byKind.lesson.body.messages[0].content.at(-2).cache_control, "cache breakpoint on the last shared block");
  for (const needle of ["Facilitated diffusion", "Tonicity", "phospholipid bilayer", "Endocytosis", "Unit 4 test on Friday", "<student_context>", "Unit 4 Test: Cells & Transport (quiz/test, due in 4 days", "Diffusion Worksheet: 12/20 (60%) — struggled here", "Missing work: Microscope Lab"]) {
    assert.ok(sent.includes(needle), `model input includes: ${needle}`);
  }
  for (const needle of ["Test Student", "alert(1)", "test-token", "movie.mp4"]) {
    assert.ok(!sent.includes(needle), `model input excludes: ${needle}`);
  }
  assert.equal(byKind.quiz.body.output_config.format.type, "json_schema");
  assert.equal(byKind.lesson.body.fallbacks, "default");
  assert.match(String(byKind.lesson.beta), /server-side-fallback-2026-07-01/);
  assert.match(byKind.quiz.body.messages[0].content.at(-1).text, /10 multiple-choice/);
  step("model input: all materials, student context, no name or token, cacheable prefix");

  // --- Quiz ------------------------------------------------------------------------------------
  await page.getByRole("tab", { name: /Practice quiz/ }).click();
  await page.getByText("10 questions.").waitFor();
  await page.getByText(/Timed \(/).click(); // untimed, so the run is deterministic
  await page.getByRole("button", { name: "Start quiz" }).click();
  for (let i = 0; i < 10; i++) {
    await page.getByText(`Question ${i + 1}`, { exact: false }).first().waitFor();
    const trueFalse = (await page.locator(".tile").count()) === 2;
    const right = trueFalse ? /: False$/ : /: Osmosis$/;
    const wrong = trueFalse ? /: True$/ : /: Exocytosis$/;
    if (i === 0 && shots) await page.screenshot({ path: path.join(out, "05-quiz.png") });
    if (i === 1) await page.keyboard.press(String(1 + (await page.locator(".tile").evaluateAll((els) => els.findIndex((e) => /Exocytosis/.test(e.textContent))))));
    else await page.getByRole("button", { name: i === 4 ? wrong : right }).click();
    await page.getByText(i === 1 || i === 4 ? "Not quite" : "Correct!").waitFor();
    if (i === 1 && shots) await page.screenshot({ path: path.join(out, "06-feedback.png") });
    await page.keyboard.press("Enter");
  }
  await page.getByText("8/10").waitFor();
  await page.getByText("By topic").waitFor();
  await page.getByText("Review what you missed").waitFor();
  if (shots) await page.screenshot({ path: path.join(out, "07-results.png"), fullPage: true });
  await page.getByRole("button", { name: "Retry the 2 I missed" }).click();
  await page.getByText("of 2").waitFor();
  step("quiz: tap and keyboard answers, feedback, scoring, results, retry missed");

  // --- Library survives a reload -----------------------------------------------------------------
  await page.reload();
  await page.getByRole("button", { name: /Cell Membranes and Transport.*10 questions.*best 8\/10/s }).click();
  await page.getByRole("heading", { name: "Membrane structure" }).waitFor();
  await page.getByText("Connected as").waitFor({ state: "detached" });
  step("study set and best score are saved in the browser");

  // --- A failed resource can be retried on its own ---------------------------------------------------
  await page.getByRole("button", { name: "New study set" }).click();
  await page.getByRole("button", { name: "Paste notes" }).click();
  await page.getByPlaceholder(/Paste notes, a study guide/).fill("Photosynthesis happens in chloroplasts and makes glucose.");
  process.env.MOCK_MODEL_FAIL = "quiz";
  requests.length = 0;
  await page.getByRole("button", { name: "Create my study set" }).click();
  await page.getByRole("tab", { name: /Practice quiz/ }).click();
  await page.getByText(/AI service returned an error/).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Download" }).waitFor({ state: "detached" });
  await page.getByRole("tab", { name: /Full lesson/ }).click();
  await page.getByRole("button", { name: "Download" }).waitFor({ timeout: 60_000 });
  delete process.env.MOCK_MODEL_FAIL;
  const before = requests.length;
  await page.getByRole("tab", { name: /Practice quiz/ }).click();
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("button", { name: "Start quiz" }).waitFor({ timeout: 60_000 });
  assert.equal(requests.length - before, 1, "retry regenerates only the failed resource");
  await page.getByRole("tab", { name: /Full lesson/ }).click();
  await page.getByRole("heading", { name: "Membrane structure" }).waitFor();
  step("a failed quiz shows an error and retries alone, keeping the lesson");

  // --- Disconnect ---------------------------------------------------------------------------------------
  await page.getByRole("button", { name: "Back" }).click();
  // The Canvas panel opens by itself when an account is connected.
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("button", { name: /Sign in with Canvas/ }).waitFor();
  assert.ok(!(await context.cookies()).some((c) => c.name === "sk_canvas"), "disconnect removes the credential");
  const denied = await page.request.get(`${APP}/api/canvas/courses`);
  assert.equal(denied.status(), 401);
  step("disconnect removes the Canvas credential");

  // --- File types: what each kind of upload turns into ------------------------------------------------------
  const zip = (files) => {
    const z = new JSZip();
    for (const [name, body] of Object.entries(files)) z.file(name, body);
    return z.generateAsync({ type: "nodebuffer" });
  };
  const docx = await zip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Mitochondria make ATP by cellular respiration.</w:t></w:r></w:p></w:body></w:document>',
  });
  const slide = (t) => `<p:sld xmlns:a="x" xmlns:p="y"><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
  const pptx = await zip({
    "ppt/presentation.xml": "<p:presentation/>",
    "ppt/slides/slide1.xml": slide("Glycolysis splits glucose &amp; makes pyruvate"),
    "ppt/slides/slide2.xml": slide("Krebs cycle"),
    "ppt/slides/slide10.xml": slide("Electron transport chain"),
    "ppt/notesSlides/notesSlide2.xml": slide("Remember: happens in the matrix") + slide("2"),
  });
  const send = async (files) => {
    requests.length = 0;
    const form = new FormData();
    form.set("options", JSON.stringify({ resources: ["review"], quizLength: 10, gradeLevel: "10th grade", focus: "" }));
    for (const [name, buffer] of Object.entries(files)) form.append("files", new Blob([buffer]), name);
    const res = await fetch(`${APP}/api/generate`, { method: "POST", body: form });
    const text = await res.text();
    return { status: res.status, events: res.ok ? text.trim().split("\n").map((l) => JSON.parse(l)) : [], text };
  };
  const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
  const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const mixed = await send({ "notes.docx": docx, "deck.pptx": pptx, "chapter.pdf": pdfBytes, "photo.png": pngBytes, "old.doc": Buffer.from("legacy") });
  assert.equal(mixed.status, 200);
  const materialsEvent = mixed.events.find((e) => e.type === "materials");
  assert.deepEqual(materialsEvent.items.map((m) => `${m.name}:${m.as}`), ["notes.docx:text", "deck.pptx:text", "chapter.pdf:pdf", "photo.png:image"]);
  assert.match(materialsEvent.warnings.join(" "), /old\.doc.*old Office format/);
  const blocks = requests[0].body.messages[0].content;
  const texts = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  assert.match(texts, /Mitochondria make ATP by cellular respiration\./);
  assert.match(texts, /--- Slide 1 ---\nGlycolysis splits glucose & makes pyruvate\n\n--- Slide 2 ---\nKrebs cycle\n\[Speaker notes\]\nRemember: happens in the matrix\n\n--- Slide 10 ---\nElectron transport chain/);
  assert.equal(blocks.find((b) => b.type === "document").source.media_type, "application/pdf");
  assert.equal(blocks.find((b) => b.type === "image").source.media_type, "image/png");
  assert.match(texts, /Grade level: 10th grade/);
  assert.equal(requests.length, 1, "only the requested resource is generated");
  const none = await send({ "clip.mov": Buffer.from("nope") });
  assert.equal(none.status, 400, "nothing readable is a clear error, not an empty study set");
  const cross = await fetch(`${APP}/api/generate`, { method: "POST", headers: { Origin: "https://evil.example" }, body: new FormData() });
  assert.equal(cross.status, 403, "cross-site POSTs are refused");
  step("Word, PowerPoint, PDF and image uploads reach the model in the right form");

  // --- Phone layout ----------------------------------------------------------------------------------------
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: shots ? 2 : 1 });
  await phone.addInitScript((lib) => localStorage.setItem("studykit.library.v1", lib), await page.evaluate(() => localStorage.getItem("studykit.library.v1")));
  const mobile = await phone.newPage();
  await mobile.goto(APP);
  await mobile.getByRole("heading", { name: /Turn any class material/ }).waitFor();
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll on the home page");
  if (shots) await mobile.screenshot({ path: path.join(out, "08-mobile-home.png"), fullPage: true });
  await mobile.getByRole("button", { name: /Cell Membranes and Transport/ }).first().click();
  await mobile.getByRole("tab", { name: /Practice quiz/ }).click();
  await mobile.getByRole("button", { name: "Start quiz" }).click();
  await mobile.locator(".tile").first().waitFor();
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll in the quiz");
  if (shots) await mobile.screenshot({ path: path.join(out, "09-mobile-quiz.png") });
  step("phone layout fits");

  assert.deepEqual(errors, [], "no browser errors");
  console.log("\nAll end-to-end checks passed.");
} catch (err) {
  console.error("\nFAILED:", err);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(), 500);
}
