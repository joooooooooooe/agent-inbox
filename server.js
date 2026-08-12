'use strict';

// Agent Inbox — local-only HTTP server. Thin layer: all store logic lives in
// lib/store.js. Binds 127.0.0.1 only; no CORS headers, ever.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const store = require('./lib/store');
const openFile = require('./lib/open-file');

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
  if (pathname === '/api/open') {
    // Resolution is synchronous so a bad path still answers 400/404. Only the
    // launch is detached — the browser should not wait on a cold editor start.
    const abs = openFile.resolveMarkdownPath(DATA_DIR, body.id, body.path);
    openFile.launchEditor(abs).catch((err) => {
      console.error(`[agent-inbox] launching the editor failed: ${err.message}`);
    });
    return sendJson(res, 200, { ok: true, path: abs });
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

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/' || pathname === '/index.html') return serveIndex(res);
      if (pathname === '/linkify.js') {
        return serveStatic(
          res,
          path.join(__dirname, 'public', 'linkify.js'),
          'application/javascript; charset=utf-8',
        );
      }
      if (pathname === '/api/state') return sendJson(res, 200, store.getState(DATA_DIR));
      if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 404, { error: 'not found' });
    }

    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      if (!hostAllowed(req)) {
        return sendJson(res, 403, { error: 'forbidden: unexpected Host header' });
      }
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

server.listen(PORT, HOST, () => {
  console.log(
    `Agent Inbox listening on http://${HOST}:${PORT}  (data dir: ${DATA_DIR}; ` +
    `store created: ${BOOT.created}; PROTOCOL.md synced: ${BOOT.protocolSynced})`,
  );
});
