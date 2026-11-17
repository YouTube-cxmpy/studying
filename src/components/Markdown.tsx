"use client";

import { Children, type ReactNode, isValidElement, memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { slugify } from "@/lib/client";
import { FigureBlock } from "./Figure";

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) return textOf(child.props.children);
      return "";
    })
    .join("");
}

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

/** Renders model-written Markdown with tables and LaTeX math. Raw HTML is not rendered. */
export const Markdown = memo(function Markdown({ text, inline = false }: { text: string; inline?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={{
        h2: ({ children }) => <h2 id={slugify(textOf(children))}>{children}</h2>,
        pre: ({ children }) => {
          // Fenced ```graph and ```svg blocks are pictures, not code.
          const code = Children.toArray(children)[0];
          if (isValidElement<{ className?: string; children?: ReactNode }>(code)) {
            const lang = /language-(\w+)/.exec(code.props.className ?? "")?.[1];
            if (lang === "graph" || lang === "svg") {
              return <FigureBlock lang={lang} source={textOf(code.props.children)} />;
            }
          }
          return <pre>{children}</pre>;
        },
        table: ({ children }) => (
          <div className="table-scroll">
            <table>{children}</table>
          </div>
        ),
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        ...(inline ? { p: ({ children }) => <span>{children}</span> } : {}),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

/**
 * While a document streams in, a picture block that has started but not finished
 * would flash an error; leave it out until its closing fence arrives.
 */
export function hideOpenFigure(markdown: string): string {
  const fences = [...markdown.matchAll(/^\s*```(\w*)/gm)];
  if (fences.length % 2 === 0) return markdown;
  const last = fences[fences.length - 1];
  return last[1] === "graph" || last[1] === "svg" ? markdown.slice(0, last.index) : markdown;
}

/** The "## " headings of a document, for the table of contents. */
export function headingsOf(markdown: string): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      const title = match[1].replace(/[*_`$]/g, "");
      out.push({ id: slugify(title), title });
    }
  }
  return out;
}

export function titleOf(markdown: string): string | null {
  return /^#\s+(.+?)\s*$/m.exec(markdown)?.[1]?.replace(/[*_`]/g, "") ?? null;
}
