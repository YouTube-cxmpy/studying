"use client";

import type { GenerateEvent, StudySet } from "./types";

// Browser-side helpers: the streaming call, the saved-set library, and image
// downscaling for phone photos.

export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new RequestError(data?.error ?? "Something went wrong. Please try again.", res.status);
  return data as T;
}

/** POSTs the material and yields the server's events as they arrive. */
export async function* streamGenerate(form: FormData, signal: AbortSignal): AsyncGenerator<GenerateEvent> {
  const res = await fetch("/api/generate", { method: "POST", body: form, signal });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new RequestError(
      data?.error ?? (res.status === 413 ? "That upload is too large." : "Couldn't start generating. Please try again."),
      res.status,
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as GenerateEvent;
    }
  }
}

// ---- Library (saved in this browser only) ----------------------------------

const LIBRARY_KEY = "studykit.library.v1";

export function loadLibrary(): StudySet[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const sets = raw ? (JSON.parse(raw) as StudySet[]) : [];
    return Array.isArray(sets) ? sets : [];
  } catch {
    return [];
  }
}

/** Returns false if the browser refused to store it (storage full or blocked). */
export function saveLibrary(sets: StudySet[]): boolean {
  // If storage is full, drop the oldest sets until the rest fits.
  for (let keep = sets.length; keep > 0; keep--) {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(sets.slice(0, keep)));
      return keep === sets.length;
    } catch {
      continue;
    }
  }
  return false;
}

export function newId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---- Files -------------------------------------------------------------------

const IMAGE_TARGET_BYTES = 1_500_000;
const IMAGE_MAX_EDGE = 2200;

/**
 * Phone photos of notes are often 5–10 MB. Shrink large images before upload;
 * 2200px on the long edge keeps handwriting legible.
 */
export async function prepareFile(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size <= IMAGE_TARGET_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[a-z0-9]+$/i, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section"
  );
}
