'use strict';

/* A small markdown parser for the documents agents link to from cards.
   Lives in its own file, like linkify.js, so it can be unit-tested under node
   while still loading as a plain browser global — the repo has no build step.

   It produces a token tree and nothing else. Turning tokens into DOM is the
   caller's job (index.html), which is what keeps the XSS invariant in one
   place: no HTML string is ever produced here, so none can be injected.

   Supported, because it is what design docs and plans actually use:
     # headings, paragraphs, --- rules
     - bullet lists and 1. ordered lists, nested by indentation
     > blockquotes
     ``` fenced code ``` and `inline code`
     GFM tables
     **bold**, *italic*, ~~strikethrough~~, [links](url)

   Deliberately unsupported: raw HTML (it is the whole XSS surface, and is
   dropped as literal text), images, reference links, setext headings. */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Markdown = api;
}(typeof self !== 'undefined' ? self : this, function () {
  // -------------------------------------------------------------------------
  // Inline
  // -------------------------------------------------------------------------

  // Emphasis delimiters must hug their content: the character after the
  // opener and the one before the closer are both non-space. Without that,
  // "2 * 3 * 4" reads as emphasis, which is how arithmetic in a design doc
  // silently turns italic.
  // `delim` is the regex for the delimiter, `ch` the single character to
  // exclude from the content (they differ whenever the delimiter needs
  // escaping).
  const hug = (delim, ch) => new RegExp(
    `${delim}([^${ch}\\s](?:[^${ch}]*[^${ch}\\s])?)${delim}`,
  );

  // Ordered by precedence. Code first: a code span suppresses everything
  // inside it, which is why `**not bold**` stays literal.
  const INLINE_RULES = [
    { type: 'code', re: /`([^`]+)`/ },
    { type: 'link', re: /\[([^\]]*)\]\(([^)\s]+)\)/ },
    { type: 'strong', re: hug('\\*\\*', '\\*') },
    { type: 'strong', re: hug('__', '_') },
    { type: 'strike', re: hug('~~', '~') },
    { type: 'em', re: hug('\\*', '\\*') },
    { type: 'em', re: hug('_', '_') },
  ];

  function parseInline(text) {
    const input = typeof text === 'string' ? text : '';
    if (input === '') return [];

    // Find whichever delimiter opens earliest; ties go to the higher-
    // precedence rule, which is why the loop keeps the first strict winner.
    let best = null;
    for (const rule of INLINE_RULES) {
      const match = rule.re.exec(input);
      if (match && (best === null || match.index < best.match.index)) {
        best = { rule, match };
      }
    }
    if (best === null) return [{ type: 'text', value: input }];

    const { rule, match } = best;
    const nodes = [];
    if (match.index > 0) {
      nodes.push(...parseInline(input.slice(0, match.index)));
    }
    if (rule.type === 'code') {
      nodes.push({ type: 'code', value: match[1] });
    } else if (rule.type === 'link') {
      nodes.push({ type: 'link', href: match[2], children: parseInline(match[1]) });
    } else {
      nodes.push({ type: rule.type, children: parseInline(match[1]) });
    }
    const rest = input.slice(match.index + match[0].length);
    if (rest !== '') nodes.push(...parseInline(rest));
    return nodes;
  }

  // -------------------------------------------------------------------------
  // Block
  // -------------------------------------------------------------------------

  const HEADING_RE = /^(#{1,6})\s+(.*)$/;
  const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
  const FENCE_RE = /^\s{0,3}(?:```|~~~)\s*([\w+-]*)\s*$/;
  const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
  const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
  const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;
  const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function splitRow(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => parseInline(cell.trim()));
  }

  // Consumes one list (all items at the same indent, with deeper-indented
  // lines recursed into as nested lists). Returns [token, nextIndex].
  function parseList(lines, start) {
    const first = BULLET_RE.exec(lines[start]) || ORDERED_RE.exec(lines[start]);
    const ordered = !BULLET_RE.test(lines[start]);
    const indent = first[1].length;
    const items = [];
    let i = start;

    while (i < lines.length) {
      const line = lines[i];
      const match = BULLET_RE.exec(line) || ORDERED_RE.exec(line);
      if (!match) break;
      if (match[1].length < indent) break;

      if (match[1].length > indent) {
        // Deeper: belongs to the item just added.
        const [nested, next] = parseList(lines, i);
        if (items.length > 0) items[items.length - 1].children.push(nested);
        i = next;
        continue;
      }
      // A different marker at the same indent starts a different list.
      const sameKind = ordered ? ORDERED_RE.test(line) : BULLET_RE.test(line);
      if (!sameKind) break;

      // Lazy continuation: a wrapped bullet keeps going on the next line(s)
      // until a blank line or the start of another block. Without this, every
      // bullet long enough to wrap would break into a stray paragraph.
      const parts = [match[2]];
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() === '') break;
        if (BULLET_RE.test(next) || ORDERED_RE.test(next)) break;
        if (HEADING_RE.test(next) || HR_RE.test(next) || FENCE_RE.test(next)
            || QUOTE_RE.test(next)) break;
        parts.push(next.trim());
        i += 1;
      }

      items.push({ inline: parseInline(parts.join(' ')), children: [] });
    }
    return [{ type: 'list', ordered, items }, i];
  }

  function parse(input) {
    const text = typeof input === 'string' ? input : '';
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (line.trim() === '') { i += 1; continue; }

      const fence = FENCE_RE.exec(line);
      if (fence) {
        const body = [];
        i += 1;
        while (i < lines.length && !FENCE_RE.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1; // closing fence, or the end of the document
        blocks.push({ type: 'code', lang: fence[1] || '', value: body.join('\n') });
        continue;
      }

      if (HR_RE.test(line)) {
        blocks.push({ type: 'hr' });
        i += 1;
        continue;
      }

      const heading = HEADING_RE.exec(line);
      if (heading) {
        blocks.push({
          type: 'heading',
          level: heading[1].length,
          inline: parseInline(heading[2].trim()),
        });
        i += 1;
        continue;
      }

      if (QUOTE_RE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          body.push(QUOTE_RE.exec(lines[i])[1]);
          i += 1;
        }
        blocks.push({ type: 'quote', blocks: parse(body.join('\n')) });
        continue;
      }

      // A table is a header row followed by a |---|---| divider. Without the
      // divider the same line is just a paragraph containing pipes.
      if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER_RE.test(lines[i + 1])) {
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        blocks.push({ type: 'table', header, rows });
        continue;
      }

      if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
        const [list, next] = parseList(lines, i);
        blocks.push(list);
        i = next;
        continue;
      }

      // Paragraph: everything up to a blank line or the start of another block.
      const para = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const l = lines[i];
        if (HEADING_RE.test(l) || HR_RE.test(l) || FENCE_RE.test(l) || QUOTE_RE.test(l)
            || BULLET_RE.test(l) || ORDERED_RE.test(l)) break;
        para.push(l.trim());
        i += 1;
      }
      if (para.length > 0) {
        blocks.push({ type: 'paragraph', inline: parseInline(para.join(' ')) });
      }
    }

    return blocks;
  }

  return { parse, parseInline };
}));
