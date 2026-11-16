import JSZip from "jszip";
import mammoth from "mammoth";
import { convert } from "html-to-text";

// Turns an uploaded or imported file into something Claude can read. PDFs and
// images go to the model as-is (so diagrams, handwriting and layout survive);
// Office documents and plain text are reduced to their text.

export type Part =
  | { as: "pdf"; name: string; data: Buffer }
  | { as: "image"; name: string; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: Buffer }
  | { as: "text"; name: string; text: string };

export class ExtractError extends Error {}

const TEXT_EXTENSIONS = ["txt", "md", "markdown", "csv", "tsv", "json", "tex", "rtf", "html", "htm"];
const SUPPORTED = ["pdf", "docx", "pptx", "png", "jpg", "jpeg", "gif", "webp", ...TEXT_EXTENSIONS];
const MAX_IMAGE_BYTES = 3_700_000; // 5 MB once base64-encoded

function extension(name: string): string {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
}

export function isSupportedFileName(name: string): boolean {
  return SUPPORTED.includes(extension(name));
}

function startsWith(bytes: Buffer, signature: number[]): boolean {
  return signature.every((b, i) => bytes[i] === b);
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** Pulls the paragraphs of text out of one slide's (or notes page's) DrawingML. */
function slideText(xml: string): string {
  return xml
    .split(/<\/a:p>/)
    .map((p) =>
      Array.from(p.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g), (m) => decodeXml(m[1]))
        .join("")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

async function pptxToText(zip: JSZip): Promise<string> {
  const numbered = (prefix: string) =>
    Object.keys(zip.files)
      .map((path) => ({ path, n: Number(new RegExp(`^${prefix}(\\d+)\\.xml$`).exec(path)?.[1]) }))
      .filter((f) => Number.isFinite(f.n))
      .sort((a, b) => a.n - b.n);

  const out: string[] = [];
  for (const { path, n } of numbered("ppt/slides/slide")) {
    const body = slideText(await zip.file(path)!.async("string"));
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    // Notes pages repeat the slide number as a lone digit; drop that line.
    const notes = notesFile
      ? slideText(await notesFile.async("string")).split("\n").filter((l) => !/^\d+$/.test(l)).join("\n")
      : "";
    out.push(`--- Slide ${n} ---\n${body}${notes ? `\n[Speaker notes]\n${notes}` : ""}`);
  }
  return out.join("\n\n");
}

function decodeText(bytes: Buffer, name: string): string {
  // A NUL byte in the first chunk means this isn't really a text file.
  if (bytes.subarray(0, 4096).includes(0)) {
    throw new ExtractError(`"${name}" isn't a readable text file.`);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export async function extractFile(name: string, mime: string, bytes: Buffer): Promise<Part> {
  const ext = extension(name);
  if (bytes.length === 0) throw new ExtractError(`"${name}" is empty.`);

  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return { as: "pdf", name, data: bytes };

  const image =
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ? "image/png"
    : startsWith(bytes, [0xff, 0xd8, 0xff]) ? "image/jpeg"
    : startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) ? "image/gif"
    : startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp"
    : null;
  if (image) {
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ExtractError(`"${name}" is too large for an image (limit about 3.5 MB). Try a smaller photo.`);
    }
    return { as: "image", name, mediaType: image, data: bytes };
  }

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new ExtractError(`"${name}" couldn't be opened.`);
    }
    let text: string;
    if (zip.file("word/document.xml")) {
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    } else if (zip.file("ppt/presentation.xml")) {
      text = await pptxToText(zip);
    } else {
      throw new ExtractError(`"${name}" isn't a supported file type. Use PDF, Word, PowerPoint, images, or text.`);
    }
    if (text.replace(/--- Slide \d+ ---/g, "").trim().length < 20) {
      throw new ExtractError(
        `"${name}" has no readable text (it may be all images). Export it as a PDF and upload that instead.`,
      );
    }
    return { as: "text", name, text };
  }

  if (ext === "doc" || ext === "ppt") {
    throw new ExtractError(`"${name}" is an old Office format. Save it as .${ext}x or PDF and try again.`);
  }
  if (ext === "heic" || mime === "image/heic") {
    throw new ExtractError(`"${name}" is a HEIC photo. Convert it to JPEG or take a screenshot of it.`);
  }

  if (TEXT_EXTENSIONS.includes(ext) || mime.startsWith("text/")) {
    let text = decodeText(bytes, name);
    if (ext === "html" || ext === "htm" || mime === "text/html") text = convert(text, { wordwrap: false });
    if (text.trim().length === 0) throw new ExtractError(`"${name}" is empty.`);
    return { as: "text", name, text };
  }

  throw new ExtractError(`"${name}" isn't a supported file type. Use PDF, Word, PowerPoint, images, or text.`);
}
