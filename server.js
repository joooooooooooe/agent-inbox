'use strict';

// Agent Inbox — local-only HTTP server. Thin layer: all store logic lives in
// lib/store.js. Binds 127.0.0.1 only; no CORS headers, ever.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const store = require('./lib/store');
const documents = require('./lib/documents');
const submissions = require('./lib/submissions');
const { check } = require('./lib/check');

const DATA_DIR = process.env.AGENT_INBOX_DATA_DIR || path.join(os.homedir(), '.agent-inbox');
const PORT = Number(process.env.AGENT_INBOX_PORT) || 7717;
const HOST = '127.0.0.1';
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
const PROTOCOL_SOURCE = path.join(__dirname, 'protocol', 'PROTOCOL.md');
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

const ACTION_ROUTE = /^\/api\/requests\/([^/]+)\/(answer|status|archive)$/;

const BOOT = store.ensureStore(DATA_DIR, PROTOCOL_SOURCE);

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  if (err instanceof store.StoreError) {
    if (err.code === 'IO') {
      console.error(`[agent-inbox] IO error: ${err.message}`);
    }
    return sendJson(res, err.httpStatus, { error: err.message });
  }
  console.error(`[agent-inbox] unexpected error: ${err.message}\n${err.stack}`);
  return sendJson(res, 500, { error: `internal error: ${err.message}` });
}

function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

function contentTypeIsJson(req) {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return ct === 'application/json';
}

function readBody(req, res, onDone) {
  const chunks = [];
  let size = 0;
  let finished = false;
  req.on('data', (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      finished = true;
      sendJson(res, 413, { error: 'request body exceeds 1 MB' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (finished) return;
    finished = true;
    onDone(Buffer.concat(chunks).toString('utf8'));
  });
  req.on('error', () => {
    if (finished) return;
    finished = true;
    try {
      sendJson(res, 500, { error: 'request stream error' });
    } catch (_) {
      // response may already be unusable
    }
  });
}

function serveStatic(res, filePath, contentType) {
  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch (err) {
    return sendJson(res, 404, { error: `not found: ${path.basename(filePath)}` });
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  return res.end(body);
}

function serveIndex(res) {
  let html;
  try {
    html = fs.readFileSync(INDEX_HTML);
  } catch (err) {
    return sendJson(res, 500, { error: `cannot read public/index.html: ${err.message}` });
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': html.length,
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function handlePost(pathname, body, res) {
  if (pathname === '/api/check') return sendJson(res, 200, check(DATA_DIR, body.project, body));
  if (pathname === '/api/submissions') {
    return sendJson(res, 201, { submission: submissions.publicRecord(submissions.create(DATA_DIR, body)) });
  }
  const submissionAction = /^\/api\/submissions\/([^/]+)\/(operator|read)$/.exec(pathname);
  if (submissionAction) {
    let id;
    try { id = decodeURIComponent(submissionAction[1]); }
    catch (_) { return sendJson(res, 400, { error: 'invalid submission id' }); }
    const result = submissionAction[2] === 'read'
      ? submissions.markRead(DATA_DIR, id, body.through)
      : submissions.operatorUpdate(DATA_DIR, id, body);
    return sendJson(res, 200, { submission: submissions.publicRecord(result) });
  }
  if (pathname === '/api/file') {
    // Read a document a card links to, so the app can render it in place.
    // resolveMarkdownPath is the boundary: repo-relative, inside that card's
    // own repo, markdown only.
    return sendJson(res, 200, documents.readMarkdown(DATA_DIR, body.id, body.path));
  }
  if (pathname === '/api/requests') {
    const request = store.createRequest(DATA_DIR, body);
    return sendJson(res, 201, { request });
  }
  const match = ACTION_ROUTE.exec(pathname);
  if (match) {
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch (_) {
      return sendJson(res, 400, { error: 'malformed request id in URL' });
    }
    // Path-traversal gate: validate BEFORE any filesystem access.
    if (!store.validateId(id)) {
      return sendJson(res, 400, { error: 'invalid request id' });
    }
    if (match[2] === 'answer') {
      const result = store.answerRequest(DATA_DIR, id, {
        value: body.value,
        notes: body.notes,
        force: body.force === true,
      });
      return sendJson(res, 200, result);
    }
    if (match[2] === 'archive') {
      const result = store.archiveRequest(DATA_DIR, id);
      return sendJson(res, 200, result);
    }
    const result = store.setStatus(DATA_DIR, id, {
      status: body.status,
      superseded_by: body.superseded_by,
      returned_reason: body.returned_reason,
    });
    return sendJson(res, 200, result);
  }
  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  try {
    const pathname = String(req.url || '/').split('?')[0];

    // Every /api/ route — reads included — is Host-gated. Binding 127.0.0.1
    // stops remote connections but not DNS rebinding: a page on a domain the
    // attacker points at 127.0.0.1 becomes same-origin and can read responses.
    // Without this, such a page could GET the whole inbox (every question,
    // answer, and the repo paths in projects.json). A real browser cannot
    // forge Host, so checking it is what closes the hole.
    if (pathname.startsWith('/api/') && !hostAllowed(req)) {
      return sendJson(res, 403, { error: 'forbidden: unexpected Host header' });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/' || pathname === '/index.html') return serveIndex(res);
      // Browser modules that are also unit-tested under node, so they
      // cannot live inline in the page.
      if (['/linkify.js', '/markdown.js', '/notifications.js'].includes(pathname)) {
        return serveStatic(
          res,
          path.join(__dirname, 'public', pathname.slice(1)),
          'application/javascript; charset=utf-8',
        );
      }
      if (pathname === '/api/state') {
        const state = store.getState(DATA_DIR);
        const intake = submissions.list(DATA_DIR);
        state.submissions = intake.submissions.map(submissions.publicRecord);
        state.invalid.push(...intake.invalid);
        return sendJson(res, 200, state);
      }
      if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 404, { error: 'not found' });
    }

    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      if (!contentTypeIsJson(req)) {
        return sendJson(res, 415, { error: 'Content-Type must be application/json' });
      }
      return readBody(req, res, (raw) => {
        let body;
        try {
          body = raw.trim() === '' ? {} : JSON.parse(raw);
        } catch (_) {
          return sendJson(res, 400, { error: 'request body is not valid JSON' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(res, 400, { error: 'request body must be a JSON object' });
        }
        try {
          handlePost(pathname, body, res);
        } catch (err) {
          sendError(res, err);
        }
      });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendError(res, err);
  }
});

// A port clash is the one startup failure that is both likely and benign
// (the inbox is usually already running). Say so in one line instead of
// throwing a stack trace at someone who just double-clicked the launcher.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Agent Inbox is already running at http://${HOST}:${PORT} — open that, or set ` +
      'AGENT_INBOX_PORT to use a different port.',
    );
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`Not allowed to listen on port ${PORT}. Set AGENT_INBOX_PORT to a port above 1024.`);
    process.exit(1);
  }
  console.error(`Agent Inbox could not start: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(
    `Agent Inbox listening on http://${HOST}:${PORT}  (data dir: ${DATA_DIR}; ` +
    `store created: ${BOOT.created}; PROTOCOL.md synced: ${BOOT.protocolSynced})`,
  );
});
