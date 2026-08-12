'use strict';

// Resolves a card-supplied markdown path to an absolute path inside that
// card's project repo, then launches Sublime Text to open and render it.
//
// This module turns request-body input into a process spawn, so the
// validation in resolveMarkdownPath is the security boundary. Keep it strict.

const fs = require('node:fs');
const path = require('node:path');
const { spawn: nodeSpawn, execFileSync } = require('node:child_process');

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
// Editor launch
// ---------------------------------------------------------------------------

const DEFAULT_SUBL = process.env.AGENT_INBOX_SUBL
  || 'C:\\Program Files\\Sublime Text\\subl.exe';

const PREVIEW_COMMAND = 'markdown_preview {"target": "browser", "parser": "markdown"}';

const WARM_SETTLE_MS = 250;   // editor already up: just let the view load
const PROBE_MS = 250;         // gap between cold-start liveness probes
const COLD_SETTLE_MS = 750;   // after the process appears, before commanding
const MAX_PROBES = 40;        // ~10s ceiling on waiting for a cold editor

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Windows-only liveness probe. Any failure is reported as "not running", which
// costs a short wait rather than breaking the launch.
function editorIsRunning() {
  if (process.platform !== 'win32') return true;
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq sublime_text.exe', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    );
    return /sublime_text\.exe/i.test(out);
  } catch (_) {
    return false;
  }
}

function launchProblem(cmd, message) {
  return `could not launch the editor at ${cmd}: ${message}. `
    + 'Set AGENT_INBOX_SUBL if Sublime Text lives elsewhere.';
}

function runDetached(spawn, cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    if (child && typeof child.unref === 'function') child.unref();
    // A missing binary surfaces as an asynchronous 'error' event, not a throw,
    // so this handler is the only place a bad AGENT_INBOX_SUBL becomes visible.
    if (child && typeof child.on === 'function') {
      child.on('error', (err) => console.error(`[agent-inbox] ${launchProblem(cmd, err.message)}`));
    }
  } catch (err) {
    fail('IO', launchProblem(cmd, err.message));
  }
}

// Opens absPath, then asks Sublime to render it via the MarkdownPreview
// package. The two calls are separate because `subl --command` acts on the
// active view, so the file has to be loaded first.
async function launchEditor(absPath, options = {}) {
  const spawn = options.spawn || nodeSpawn;
  const sublPath = options.sublPath || DEFAULT_SUBL;
  const isRunning = options.isRunning || editorIsRunning;
  const delay = options.delay || sleep;
  const maxProbes = options.maxProbes || MAX_PROBES;

  const wasRunning = isRunning();
  runDetached(spawn, sublPath, [absPath]);

  if (wasRunning) {
    await delay(WARM_SETTLE_MS);
  } else {
    // Cold start: poll until the process exists rather than retrying the
    // command, which would risk opening two browser tabs.
    for (let i = 0; i < maxProbes; i += 1) {
      await delay(PROBE_MS);
      if (isRunning()) break;
    }
    await delay(COLD_SETTLE_MS);
  }

  runDetached(spawn, sublPath, ['--command', PREVIEW_COMMAND]);
}

module.exports = { resolveMarkdownPath, isInside, launchEditor, DEFAULT_SUBL };
