/** Minimal, dependency-free Markdown renderer for advisor chat bubbles.
 *
 * The AI's replies read best when they're scannable — a lead line, short
 * bullets, bolded key terms — so the server prompt asks for light Markdown and
 * this turns that subset into structured JSX. Deliberately small: it supports
 * only what the advisor actually emits (headings, bullets, numbered lists,
 * **bold**, `code`, blockquotes, paragraphs). Everything is rendered through
 * React text nodes — never dangerouslySetInnerHTML — so untrusted model output
 * cannot inject markup. */
import type { ReactNode } from "react";

/** Inline pass: **bold** and `code`; everything else stays literal text. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Split on the inline tokens while keeping the delimiters' content.
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) nodes.push(<strong key={`${keyBase}-b${i}`}>{m[2]}</strong>);
    else if (m[3] !== undefined) nodes.push(<code key={`${keyBase}-c${i}`}>{m[3]}</code>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function ChatMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(<p key={`p${key++}`}>{renderInline(para.join(" "), `p${key}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, j) => <li key={j}>{renderInline(it, `l${key}-${j}`)}</li>);
    blocks.push(list.ordered ? <ol key={`o${key++}`}>{items}</ol> : <ul key={`u${key++}`}>{items}</ul>);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);

    if (line.trim() === "") { flushPara(); flushList(); continue; }
    if (heading) {
      flushPara(); flushList();
      const level = Math.min(4, heading[1].length);
      const Tag = (`h${level + 2}` as "h3" | "h4" | "h5" | "h6"); // map # -> h3 (bubble scale)
      blocks.push(<Tag key={`h${key++}`}>{renderInline(heading[2], `h${key}`)}</Tag>);
    } else if (bullet) {
      flushPara();
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
      list.items.push(bullet[1]);
    } else if (numbered) {
      flushPara();
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push(numbered[1]);
    } else if (quote) {
      flushPara(); flushList();
      blocks.push(<blockquote key={`q${key++}`}>{renderInline(quote[1], `q${key}`)}</blockquote>);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className="md">{blocks}</div>;
}
