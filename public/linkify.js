'use strict';

/* Splits prose into plain-text runs and markdown-path runs.
   Lives in its own file so it can be unit-tested under node while still
   loading as a plain browser global — the repo has no build step. */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Linkify = api;
}(typeof self !== 'undefined' ? self : this, function () {
  // A path is two or more segments joined by / or \, ending in .md, with an
  // optional #section pointing at a heading inside it.
  // Requiring a separator keeps bare filenames (STATE.md) out: the protocol
  // requires repo-relative paths, and a bare name could not be resolved.
  const MD_PATH_RE = /(?:[A-Za-z]:)?[\w.~-]+(?:[\\/][\w.~-]+)+\.md(?:#[\w-]+)?(?![\w])/gi;

  function splitMarkdownPaths(input) {
    const text = typeof input === 'string' ? input : '';
    const parts = [];
    let last = 0;
    let match;
    MD_PATH_RE.lastIndex = 0;
    while ((match = MD_PATH_RE.exec(text)) !== null) {
      if (match.index > last) {
        parts.push({ type: 'text', value: text.slice(last, match.index) });
      }
      parts.push({ type: 'path', value: match[0] });
      last = match.index + match[0].length;
    }
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
    if (parts.length === 0) parts.push({ type: 'text', value: '' });
    return parts;
  }

  return { splitMarkdownPaths };
}));
