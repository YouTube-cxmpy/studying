// A tiny stand-in for the Canvas LMS API, for local testing without a school account.
//   node test/mock-canvas.mjs            → http://127.0.0.1:4010, token "test-token"
import http from "node:http";

const PORT = Number(process.env.MOCK_CANVAS_PORT ?? 4010);
const TOKEN = "test-token";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const day = 86_400_000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * day).toISOString();

// Ids above 2^53 check that string ids survive the round trip.
const COURSE = "17540000000000101";
const courses = [
  {
    id: COURSE,
    name: "Biology 1 — Period 3",
    course_code: "BIO1-P3",
    term: { name: "Fall 2026" },
    enrollments: [{ type: "student", computed_current_score: 84.5 }],
    syllabus_body: "<h2>Biology 1</h2><p>Unit 4 covers cell structure, membranes and transport. Unit test at the end of the month.</p>",
  },
  { id: "17540000000000102", name: "World History", course_code: "WH", enrollments: [{ type: "student" }] },
  { id: "17540000000000103", name: "Old Course", access_restricted_by_date: true },
];

const pages = {
  "cell-membrane-notes": {
    title: "Cell Membrane Notes",
    body: "<h2>The Cell Membrane</h2><p>The membrane is a <strong>phospholipid bilayer</strong> with embedded proteins (the fluid mosaic model).</p><ul><li>Passive transport: diffusion, osmosis, facilitated diffusion — no ATP.</li><li>Active transport: pumps move solutes against the gradient using ATP.</li></ul><script>alert(1)</script>",
  },
  "osmosis-lab": { title: "Osmosis Lab Background", body: "<p>Water moves from hypotonic to hypertonic solutions across a selectively permeable membrane.</p>" },
  "empty-page": { title: "Empty Page", body: "" },
};

const assignments = [
  { id: "9001", name: "Unit 4 Test: Cells & Transport", due_at: iso(4), points_possible: 100, submission_types: ["online_quiz"], is_quiz_assignment: true, description: "<p>Covers membrane structure, diffusion, osmosis, active transport.</p>", submission: { workflow_state: "unsubmitted" } },
  { id: "9002", name: "Osmosis Lab Report", due_at: iso(9), points_possible: 40, submission_types: ["online_upload"], description: "<p>Write up your potato osmosis lab: hypothesis, data table, analysis of tonicity.</p>", submission: { workflow_state: "unsubmitted" } },
  { id: "9003", name: "Diffusion Worksheet", due_at: iso(-6), points_possible: 20, submission_types: ["online_upload"], description: "<p>Practice problems.</p>", submission: { score: 12, submitted_at: iso(-7), workflow_state: "graded" } },
  { id: "9004", name: "Organelles Quiz", due_at: iso(-12), points_possible: 30, submission_types: ["online_quiz"], submission: { score: 28, submitted_at: iso(-12), workflow_state: "graded" } },
  { id: "9005", name: "Microscope Lab", due_at: iso(-3), points_possible: 15, submission_types: ["online_upload"], submission: { missing: true, workflow_state: "unsubmitted" } },
];

const files = {
  "7001": { id: "7001", display_name: "Transport Summary.txt", "content-type": "text/plain", size: 120, body: "Endocytosis brings material into the cell in vesicles. Exocytosis releases material. Both are bulk transport and need energy." },
  "7002": { id: "7002", display_name: "lecture.mov", "content-type": "video/quicktime", size: 9_000_000, body: "" },
};

const modules = [
  {
    id: "501",
    name: "Unit 4: Cells & Transport",
    items_count: 6,
    items: [
      { id: "1", title: "Readings", type: "SubHeader" },
      { id: "2", title: "Cell Membrane Notes", type: "Page", page_url: "cell-membrane-notes" },
      { id: "3", title: "Transport Summary.txt", type: "File", content_id: "7001" },
      { id: "4", title: "Osmosis Lab Report", type: "Assignment", content_id: "9002" },
      { id: "5", title: "Unit 4 Test: Cells & Transport", type: "Quiz", content_id: "9001" },
      { id: "6", title: "Khan Academy video", type: "ExternalUrl" },
    ],
  },
  // Canvas omits `items` on large modules; the client must fetch them separately.
  { id: "502", name: "Unit 5: Energy", items_count: 1 },
];
const moduleItems = { "502": [{ id: "7", title: "Osmosis Lab Background", type: "Page", page_url: "osmosis-lab" }] };

const stats = {};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, ORIGIN);
    const path = url.pathname;

    if (path.startsWith("/download/")) {
      const file = files[path.split("/")[2]];
      if (!file || url.searchParams.get("verifier") !== "abc") return send(res, 403, {});
      res.writeHead(200, { "Content-Type": file["content-type"] });
      return res.end(file.body);
    }
    // OAuth: approve immediately, and hand out a token that is about to expire
    // so the app has to use its refresh token straight away.
    if (path === "/login/oauth2/auth") {
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", "auth-code");
      back.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (path === "/login/oauth2/token") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        const grant = form.get("grant_type");
        stats[grant] = (stats[grant] ?? 0) + 1;
        if (form.get("client_secret") !== "oauth-secret") return send(res, 401, {});
        if (grant === "authorization_code" && form.get("code") === "auth-code") {
          return send(res, 200, { access_token: "stale-token", refresh_token: "refresh-1", expires_in: 30, user: { name: "Test Student" } });
        }
        if (grant === "refresh_token" && form.get("refresh_token") === "refresh-1") {
          return send(res, 200, { access_token: TOKEN, expires_in: 3600 });
        }
        send(res, 400, { error: "invalid_grant" });
      });
      return;
    }
    if (path === "/__stats") return send(res, 200, stats);

    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { errors: [{ message: "Invalid access token." }] });
    if (req.method !== "GET") return send(res, 405, { message: "this mock is read-only" });

    let m;
    if (path === "/api/v1/users/self") return send(res, 200, { id: "42", name: "Test Student", short_name: "Test" });
    if (path === "/api/v1/courses") {
      // Two pages, to exercise Link-header pagination.
      const page = Number(url.searchParams.get("page") ?? 1);
      const link = page === 1 ? { Link: `<${ORIGIN}/api/v1/courses?page=2&per_page=100>; rel="next"` } : {};
      return send(res, 200, page === 1 ? courses.slice(0, 1) : courses.slice(1), link);
    }
    if ((m = /^\/api\/v1\/courses\/(\d+)$/.exec(path))) {
      const course = courses.find((c) => c.id === m[1]);
      return course ? send(res, 200, course) : send(res, 404, {});
    }
    if ((m = /^\/api\/v1\/courses\/(\d+)\/(.+)$/.exec(path)) && m[1] === COURSE) {
      const rest = m[2];
      if (rest === "modules") return send(res, 200, modules);
      if ((m = /^modules\/(\d+)\/items$/.exec(rest))) return send(res, 200, moduleItems[m[1]] ?? []);
      if (rest === "pages") return send(res, 200, Object.entries(pages).map(([url, p]) => ({ url, title: p.title })));
      if ((m = /^pages\/(.+)$/.exec(rest))) return pages[m[1]] ? send(res, 200, pages[m[1]]) : send(res, 404, {});
      // Students often can't list Files. Canvas answers that with a 401 even though the token is fine.
      if (rest === "files") return send(res, 401, { status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] });
      if ((m = /^files\/(\d+)$/.exec(rest))) {
        const f = files[m[1]];
        return f ? send(res, 200, { ...f, body: undefined, url: `${ORIGIN}/download/${f.id}?verifier=abc` }) : send(res, 404, {});
      }
      if (rest === "assignments") return send(res, 200, assignments);
      if ((m = /^assignments\/(\d+)$/.exec(rest))) {
        const a = assignments.find((x) => x.id === m[1]);
        return a ? send(res, 200, a) : send(res, 404, {});
      }
    }
    if (/^\/api\/v1\/courses\/\d+\/(modules|pages|files|assignments)$/.test(path)) return send(res, 200, []);
    send(res, 404, { message: "not found" });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mock Canvas on ${ORIGIN} (token: ${TOKEN})`));
