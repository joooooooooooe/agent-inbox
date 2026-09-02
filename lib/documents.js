'use strict';

// Resolves a card-supplied markdown path to an absolute path inside that
// card's project repo, and reads it so the app can render it in place.
//
// This module turns request-body input into a filesystem read, so the
// validation in resolveMarkdownPath is the security boundary. Keep it strict.
// Nothing here executes anything: the app renders documents itself, and the
// server has no process-spawning code path at all.

const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');

function fail(code, message) {
  throw new store.StoreError(code, message);
}

// True when child is the same path as parent, or sits beneath it. Compares
// against parent + separator so a sibling like "repo-evil" cannot pass a
// naive prefix test against "repo".
function isInside(parent, child) {
  const a = path.resolve(parent);
  const b = path.resolve(child);
  if (a === b) return true;
  const withSep = a.endsWith(path.sep) ? a : a + path.sep;
  // Windows paths are case-insensitive; compare accordingly on win32.
  if (process.platform === 'win32') {
    return b.toLowerCase().startsWith(withSep.toLowerCase());
  }
  return b.startsWith(withSep);
}

function resolveMarkdownPath(dataDir, id, rawPath) {
  const raw = String(rawPath == null ? '' : rawPath).trim();
  if (raw === '') fail('VALIDATION', 'no file path was given');

  // readRequest covers live and archived cards, and throws NOT_FOUND itself.
  const request = store.readRequest(dataDir, id);
  const slug = request.project;

  const registry = store.readProjects(dataDir);
  const project = registry.projects && registry.projects[slug];
  if (!project || !project.repo) {
    fail(
      'NOT_FOUND',
      `project "${slug}" is not registered in projects.json, so "${raw}" cannot be resolved`,
    );
  }
  const repoRoot = path.resolve(project.repo);

  const normalised = raw.replace(/\//g, path.sep).replace(/\\/g, path.sep);
  const abs = path.resolve(repoRoot, normalised);

  if (!isInside(repoRoot, abs)) {
    fail('VALIDATION', `"${raw}" resolves outside the ${slug} repo (${repoRoot})`);
  }
  if (!/\.md$/i.test(abs)) {
    fail('VALIDATION', `"${raw}" is not a markdown file`);
  }

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT') fail('NOT_FOUND', `no file at ${abs}`);
    fail('IO', `could not read ${abs}: ${err.message}`);
  }
  if (!stat.isFile()) fail('VALIDATION', `${abs} is not a file`);

  return abs;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Documents are rendered in the app, so they are read whole into memory. The
// cap is generous for prose but stops a stray multi-megabyte file from being
// pushed through the browser.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function readMarkdown(dataDir, id, rawPath) {
  const abs = resolveMarkdownPath(dataDir, id, rawPath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    fail('IO', `could not read ${abs}: ${err.message}`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    fail(
      'VALIDATION',
      `${abs} is ${Math.round(stat.size / 1024)} KB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB `
      + 'limit for viewing in the inbox — open it in an editor instead',
    );
  }
  let markdown;
  try {
    markdown = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    fail('IO', `could not read ${abs}: ${err.message}`);
  }
  // Strip a UTF-8 BOM: it would otherwise render as a stray character at the
  // top of the document.
  if (markdown.charCodeAt(0) === 0xfeff) markdown = markdown.slice(1);
  return { path: abs, markdown };
}

module.exports = {
  resolveMarkdownPath,
  readMarkdown,
  isInside,
};
