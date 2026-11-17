import { CanvasError, buildStudentContext, fetchMaterial } from "@/lib/canvas";
import { ExtractError, type Part, extractFile } from "@/lib/extract";
import { runGeneration } from "@/lib/generate";
import { guard, jsonError, requireCanvas } from "@/lib/http";
import type { GenerateEvent, GenerateOptions, MaterialSummary, ResourceKind } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A full lesson on a long document can take several minutes.
export const maxDuration = 800;

// The model API accepts 32 MB per request; base64 adds a third, so keep the
// raw PDFs and images under 22 MB. Text is capped well inside the context window.
const MAX_BINARY_BYTES = 22 * 1024 * 1024;
const MAX_TEXT_CHARS = 1_500_000;
const MAX_ITEMS = 40;
const KINDS: ResourceKind[] = ["lesson", "review", "cards", "quiz"];

function parseOptions(raw: FormDataEntryValue | null): GenerateOptions | null {
  if (typeof raw !== "string") return null;
  try {
    const o = JSON.parse(raw) as Partial<GenerateOptions>;
    const resources = KINDS.filter((k) => Array.isArray(o.resources) && o.resources.includes(k));
    const canvas =
      o.canvas && typeof o.canvas.courseId === "string" && Array.isArray(o.canvas.refs)
        ? {
            courseId: o.canvas.courseId,
            refs: o.canvas.refs.filter((r): r is string => typeof r === "string").slice(0, MAX_ITEMS),
            personalize: o.canvas.personalize === true,
          }
        : undefined;
    return {
      resources: resources.length ? resources : KINDS,
      quizLength: Math.min(40, Math.max(5, Math.round(Number(o.quizLength) || 15))),
      gradeLevel: String(o.gradeLevel ?? "").slice(0, 60),
      focus: String(o.focus ?? "").slice(0, 600),
      difficulty: o.difficulty === "easier" || o.difficulty === "harder" ? o.difficulty : "mixed",
      focusTopics: Array.isArray(o.focusTopics)
        ? o.focusTopics.filter((t): t is string => typeof t === "string" && t.trim() !== "").slice(0, 8)
        : [],
      avoid: Array.isArray(o.avoid)
        ? o.avoid.filter((q): q is string => typeof q === "string").map((q) => q.slice(0, 300)).slice(-150)
        : [],
      canvas,
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const blocked = await guard(request);
  if (blocked) return blocked;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("The upload couldn't be read. It may be too large.", 400);
  }
  const options = parseOptions(form.get("options"));
  if (!options) return jsonError("Invalid request.", 400);

  const parts: Part[] = [];
  const items: MaterialSummary[] = [];
  const warnings: string[] = [];
  const add = (part: Part, source: MaterialSummary["source"]) => {
    parts.push(part);
    items.push({ name: part.name, source, as: part.as });
  };

  // 1. Uploaded files
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length > MAX_ITEMS) return jsonError(`Upload at most ${MAX_ITEMS} files at a time.`, 400);
  for (const file of files) {
    try {
      add(await extractFile(file.name, file.type, Buffer.from(await file.arrayBuffer())), "upload");
    } catch (err) {
      warnings.push(err instanceof ExtractError ? err.message : `"${file.name}" couldn't be read.`);
    }
  }

  // 2. Pasted text
  const pasted = form.get("text");
  if (typeof pasted === "string" && pasted.trim()) {
    add({ as: "text", name: "Pasted notes", text: pasted }, "paste");
  }

  // 3. Items picked from Canvas, plus the personalization summary
  let studentContext: string | null = null;
  if (options.canvas && (options.canvas.refs.length > 0 || options.canvas.personalize)) {
    try {
      const session = await requireCanvas();
      const { courseId, refs, personalize } = options.canvas;
      const fetched = await Promise.allSettled(refs.map((ref) => fetchMaterial(session, courseId, ref)));
      for (const [i, result] of fetched.entries()) {
        if (result.status === "rejected") {
          const reason = result.reason instanceof CanvasError ? result.reason.message : "couldn't be loaded";
          warnings.push(`A Canvas item (${refs[i].split(":")[0]}) was skipped: ${reason}`);
          continue;
        }
        const material = result.value;
        try {
          if ("text" in material) {
            if (material.text.trim().length < 20) {
              warnings.push(`"${material.name}" from Canvas has no text to study from and was skipped.`);
            } else {
              add({ as: "text", name: material.name, text: material.text }, "canvas");
            }
          } else {
            add(await extractFile(material.name, material.mime, material.bytes), "canvas");
          }
        } catch (err) {
          warnings.push(err instanceof ExtractError ? err.message : `"${material.name}" couldn't be read.`);
        }
      }
      if (personalize) {
        try {
          studentContext = await buildStudentContext(session, courseId);
        } catch {
          warnings.push("Couldn't load assignments from Canvas, so these resources aren't personalized.");
        }
      }
    } catch (err) {
      if (err instanceof CanvasError && err.status === 401) return jsonError(err.message, 401);
      warnings.push("Canvas couldn't be reached, so Canvas items were skipped.");
    }
  }

  if (parts.length === 0) {
    return jsonError(warnings[0] ?? "Add some learning material first: a file, pasted notes, or Canvas items.", 400);
  }
  const binaryBytes = parts.reduce((n, p) => (p.as === "text" ? n : n + p.data.length), 0);
  if (binaryBytes > MAX_BINARY_BYTES) {
    return jsonError("The PDFs and images add up to more than 22 MB. Remove some, or split them into separate study sets.", 413);
  }
  const textChars = parts.reduce((n, p) => (p.as === "text" ? n + p.text.length : n), 0);
  if (textChars > MAX_TEXT_CHARS) {
    return jsonError("That's too much text for one study set. Split it into chapters or units.", 413);
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: GenerateEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
          abort.abort();
        }
      };
      emit({ type: "materials", items, warnings, personalized: studentContext !== null });
      try {
        await runGeneration({
          parts,
          resources: options.resources,
          quiz: {
            count: options.quizLength,
            difficulty: options.difficulty ?? "mixed",
            focusTopics: options.focusTopics ?? [],
            avoid: options.avoid ?? [],
          },
          gradeLevel: options.gradeLevel,
          focus: options.focus,
          studentContext,
          emit,
          signal: abort.signal,
        });
      } catch (err) {
        console.error("[generate]", err instanceof Error ? err.message : err);
        emit({ type: "error", message: "Something went wrong while generating. Please try again." });
      }
      emit({ type: "end" });
      open = false;
      try {
        controller.close();
      } catch {
        // The client already went away.
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
