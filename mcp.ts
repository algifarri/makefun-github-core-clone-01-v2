// mcp.ts — the Model Context Protocol endpoint (JSON-RPC 2.0 over
// streamable HTTP at /mcp), speaking both eras the suite accepts:
//
//   modern 2026-07-28: server/discover names the server, its tools
//           capability and every supported revision; no handshake;
//   legacy 2025-11-25 and earlier: initialize + notifications/initialized.
//
// Eight tools, exactly: create_repo, get_repo, create_issue, list_issues,
// get_issue, create_pull_request, list_pull_requests, merge_pull_request.
// A tool call answers with the same REST-shaped object the REST surface
// returns, as text JSON and as structuredContent. A missing required
// argument is a result with isError true, never a JSON-RPC error; an
// unknown tool is JSON-RPC -32602.

import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Forge, Item, Repo } from './store.ts';

const SERVER_INFO = Object.freeze({ name: 'makefun-forge', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const PREFERRED_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool list, built once: tools/list must be byte-identical across calls. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

type JsonRpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

function resultResponse(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: JsonRpcId, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

/** Find a repository or answer why it cannot be found. */
function findRepo(forge: Forge, owner: unknown, repo: unknown): Repo | string {
  if (typeof owner !== 'string' || typeof repo !== 'string') return 'owner and repo are required';
  const found = forge.getRepo(owner, repo);
  if (found === undefined) return `repository ${owner}/${repo} does not exist`;
  return found;
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function callTool(forge: Forge, origin: string, name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { rpcError: RpcError } {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  const missing = missingArgs(tool, args);
  if (missing.length > 0) {
    return { result: toolErrorResult(`Missing required argument(s): ${missing.join(', ')}`) };
  }

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const repo = forge.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      if (repo === null) return { result: toolErrorResult(`name already exists on this account: ${repoName}`) };
      return { result: toolResult(repoJson(repo, origin)) };
    }
    case 'get_repo': {
      const found = findRepo(forge, args.owner, args.repo);
      if (typeof found === 'string') return { result: toolErrorResult(found) };
      return { result: toolResult(repoJson(found, origin)) };
    }
    case 'create_issue': {
      const found = findRepo(forge, args.owner, args.repo);
      if (typeof found === 'string') return { result: toolErrorResult(found) };
      const item = forge.newItem(found, 'issue', {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return { result: toolResult(issueJson(found, item, origin)) };
    }
    case 'list_issues': {
      const found = findRepo(forge, args.owner, args.repo);
      if (typeof found === 'string') return { result: toolErrorResult(found) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...found.items.values()];
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      const list = items.map((item) => issueJson(found, item, origin));
      return { result: toolResult(list) };
    }
    case 'get_issue': {
      const found = findRepo(forge, args.owner, args.repo);
      if (typeof found === 'string') return { result: toolErrorResult(found) };
      const number = Number(args.issue_number);
      const item = found.items.get(number);
      if (item === undefined) return { result: toolErrorResult(`issue #${args.issue_number} does not exist`) };
      return { result: toolResult(issueJson(found, item, origin)) };
    }
    case 'create_pull_request': {
      const found = findRepo(forge, args.owner, args.repo);
      if (typeof found === 'string') return { result: toolErrorResult(found) };
      const head = String(args.head);
      const base = String(args.base);
      const headTip = found.refs.get(`refs/heads/${head}`);
      const baseTip = found.refs.get(`refs/heads/${base}`);
      if (headTip === undefined) return { result: toolErrorResult(`Head branch does not exist: ${head}`) };
      if (baseTip === undefined) return { result: toolErrorResult(`Base branch does not exist: ${base}`) };
      if (headTip === baseTip || forge.isAncestor(found, headTip, baseTip)) {
        return { result: toolErrorResult('No commits between base and head') };
      }
      for (const existing of found.items.values()) {
        if (existing.kind === 'pr' && existing.state === 'open' && existing.head?.ref === head && existing.base?.ref === base) {
          return { result: toolErrorResult('A pull request already exists for this head and base') };
        }
      }
      const item = forge.newItem(found, 'pr', {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: { ref: head, sha: headTip },
        base: { ref: base, sha: baseTip },
      });
      return { result: toolResult(pullJson(forge, found, item, origin)) };
    }
    case 'list_pull_requests': {
      const found = findRepo(forge, args.owner, args.repo);
      if (typeof found === 'string') return { result: toolErrorResult(found) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items: Item[] = [...found.items.values()].filter((item) => item.kind === 'pr');
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      const list = items.map((item) => pullJson(forge, found, item, origin));
      return { result: toolResult(list) };
    }
    case 'merge_pull_request': {
      const found = findRepo(forge, args.owner, args.repo);
      if (typeof found === 'string') return { result: toolErrorResult(found) };
      const number = Number(args.pull_number);
      const item = found.items.get(number);
      if (item === undefined || item.kind !== 'pr') return { result: toolErrorResult(`pull request #${args.pull_number} does not exist`) };
      if (item.merged === true) return { result: toolErrorResult('Pull request already merged') };
      if (item.state === 'closed') return { result: toolErrorResult('Pull request is closed') };
      const result = forge.mergePr(found, item, 'squash');
      if ('error' in result) return { result: toolErrorResult(result.error === 'merge conflict' ? 'Merge conflict' : result.error) };
      return { result: toolResult({ sha: result.sha, merged: true, message: 'Pull request successfully merged' }) };
    }
    default:
      return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: { ...SERVER_INFO },
    protocolVersion: PREFERRED_VERSION,
    _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
  };
}

function initializeResult(requested: unknown): Record<string, unknown> {
  const version = typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested) ? requested : PREFERRED_VERSION;
  return {
    protocolVersion: version,
    capabilities: { tools: {} },
    serverInfo: { ...SERVER_INFO },
  };
}

/** One JSON-RPC request object. Returns null for a notification (no id). */
function handleOne(forge: Forge, origin: string, request: Record<string, unknown>): { status: number; body: unknown } | null {
  const id: JsonRpcId = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const isNotification = request.id === undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  const answer = (body: Record<string, unknown>): { status: number; body: unknown } | null => {
    if (isNotification) return null;
    return { status: 200, body };
  };

  if (method === 'server/discover') {
    return answer(resultResponse(id, discoverResult()));
  }
  if (method === 'initialize') {
    return answer(resultResponse(id, initializeResult(params.protocolVersion)));
  }
  if (method === 'ping') {
    return answer(resultResponse(id, {}));
  }
  if (method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'tools/list') {
    return answer(resultResponse(id, { tools: TOOLS }));
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(forge, origin, toolName, args);
    if ('rpcError' in outcome) return answer(errorResponse(id, outcome.rpcError));
    return answer(resultResponse(id, outcome.result));
  }
  return answer(errorResponse(id, { code: -32601, message: `Method not found: ${method}` }));
}

/**
 * Handle POST /mcp. Returns the HTTP status and body (a null body means
 * 202 with no content, the answer to a notification).
 */
export function handleMcp(forge: Forge, origin: string, bodyText: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } },
    };
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const handled = handleOne(forge, origin, entry as Record<string, unknown>);
      if (handled !== null) results.push(handled.body);
    }
    return { status: 200, body: results };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body must be a JSON object' } },
    };
  }
  const handled = handleOne(forge, origin, parsed as Record<string, unknown>);
  if (handled === null) return { status: 202, body: null };
  return handled;
}
