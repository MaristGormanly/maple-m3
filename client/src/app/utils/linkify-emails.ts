/**
 * Turns plain and backtick-wrapped email addresses into Markdown mailto links before
 * marked runs, so they render as normal hyperlinks instead of monospace code spans.
 */
const EMAIL = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

/** HTML comments are inert in Markdown and are stripped by marked; safe until we restore. */
const LINK_PLACEHOLDER = (i: number) => `<!--MAPLE_MD_LINK_${i}-->`;

export function linkifyEmailsInMarkdown(markdown: string): string {
  let text = markdown.replace(
    /`([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})`/g,
    '[$1](mailto:$1)'
  );

  const saved: string[] = [];
  text = text.replace(/!?\[[^\]]*]\([^)]+\)/g, (full) => {
    saved.push(full);
    return LINK_PLACEHOLDER(saved.length - 1);
  });

  text = text.replace(EMAIL, (addr) => `[${addr}](mailto:${addr})`);

  saved.forEach((frag, i) => {
    text = text.replace(LINK_PLACEHOLDER(i), frag);
  });

  return text;
}
