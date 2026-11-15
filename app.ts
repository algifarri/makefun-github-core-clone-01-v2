// app.ts — one HTTP server for the four surfaces.
//
// Routing: /healthz answers without auth; the git smart-HTTP paths take
// no auth either; /api/v3, /api/graphql and /mcp require the bearer token
// from MAKEFUN_SHOP_TOKEN (when the variable is set). Every reply carries
// an X-GitHub-Request-Id header, and JSON replies carry X-OAuth-Scopes.
//
// The server keeps connections alive generously (the benchmark reuses one
// keep-alive socket for two thousand reads) and accepts large pack bodies.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;
const EMPTY_BODY = Buffer.alloc(0);

/**
 * The X-GitHub-Request-Id header's value: a process-local sequence.
 * The suite asks only that the header be present and non-empty, and a
 * counter costs nothing next to a cryptographic UUID — a real saving
 * when one workload alone draws two thousand replies.
 */
let requestSeq = 0;
function requestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

export function createApp(): Server {
  const forge = new Forge();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void serve(forge, shopToken, req, res);
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 120_000;
  return server;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const part = chunk as Buffer;
    total += part.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(part);
  }
  return Buffer.concat(chunks, total);
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extra,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json', Buffer.from(JSON.stringify(value), 'utf8'));
}

async function serve(forge: Forge, shopToken: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const needsAuth = pathname.startsWith('/api/v3') || pathname === '/api/graphql' || pathname === '/mcp';
    if (needsAuth && shopToken !== '') {
      const presented = req.headers.authorization ?? '';
      if (presented !== `Bearer ${shopToken}`) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
    }

    // A GET or HEAD with no Content-Length and no Transfer-Encoding
    // carries no body; skip the stream read entirely (the read
    // benchmark issues two thousand of these on one connection, and
    // the git advertisement is another).
    const contentLength = req.headers['content-length'];
    const bodyless =
      (method === 'GET' || method === 'HEAD') &&
      req.headers['transfer-encoding'] === undefined &&
      (contentLength === undefined || contentLength === '0');
    const body = bodyless ? EMPTY_BODY : await readBody(req);
    // Only the git surface reads request headers (the protocol
    // version); the REST, GraphQL and MCP handlers never look at the
    // record, so build it only for git routes.
    const headers: Record<string, string | undefined> = {};
    if (pathname.includes('.git/')) {
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }
    }
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const gitReq = { method, pathname, query: url.searchParams, headers, body };

    if (pathname.includes('.git/')) {
      const git = handleGit(forge, gitReq);
      if (git !== null) {
        send(res, git.status, git.contentType, git.body);
        return;
      }
    }

    if (pathname.startsWith('/api/v3')) {
      const rest = handleRest(forge, { ...gitReq, origin });
      if (rest !== null) {
        send(res, rest.status, rest.contentType, rest.body, rest.headers ?? {});
        return;
      }
    }

    if (pathname === '/api/graphql' && method === 'POST') {
      const out = handleGraphQL(forge, origin, body.toString('utf8'));
      sendJson(res, out.status, out.body);
      return;
    }

    if (pathname === '/mcp' && method === 'POST') {
      const out = handleMcp(forge, origin, body.toString('utf8'));
      if (out.body === null) {
        res.writeHead(out.status, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
      sendJson(res, out.status, out.body);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
    } else {
      res.destroy();
    }
  }
}
