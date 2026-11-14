// rest.ts — the GitHub REST v3 surface on the shared Forge store.
//
// Routes are the ones the suite drives: users, repositories, branches,
// git refs, commits, contents, labels, issues (and their comments) and
// pull requests (and their files and merge). Every reply is JSON with a
// message field on errors; pagination uses absolute Link headers built
// from the request's Host.
//
// One rule is load-bearing: a contents commit's message is stored exactly
// as the client sent it — no trailing newline is ever added.

import {
  isOid,
  parseCommit,
  parseTree,
  VIEWER,
  type Forge,
  type Item,
  type Label,
  type Repo,
} from './store.ts';
import type { GitRequest } from './githttp.ts';

export type RestRequest = GitRequest & { origin: string };

export interface RestResponse {
  status: number;
  body: Buffer;
  contentType: string;
  headers?: Record<string, string>;
}

function json(status: number, value: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body: Buffer.from(JSON.stringify(value), 'utf8'), contentType: 'application/json', headers };
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

function noContent(): RestResponse {
  return { status: 204, body: Buffer.alloc(0), contentType: 'application/json' };
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: '',
    avatar_url: '',
    gravatar_id: '',
    url: '',
    html_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo, origin: string): Record<string, unknown> {
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: '',
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: base,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: '',
    url: '',
    name: label.name,
    color: label.color,
    default: label.default,
    description: label.description,
  };
}

function itemUrls(repo: Repo, item: Item, origin: string): { html: string; api: string } {
  const kind = item.kind === 'pr' ? 'pull' : 'issues';
  return {
    html: `${origin}/${repo.owner}/${repo.name}/${kind}/${item.number}`,
    api: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/${kind}/${item.number}`,
  };
}

export function issueJson(repo: Repo, item: Item, origin: string): Record<string, unknown> {
  const urls = itemUrls(repo, item, origin);
  const out: Record<string, unknown> = {
    id: item.id,
    node_id: '',
    url: urls.api,
    repository_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${urls.api}/labels`,
    comments_url: `${urls.api}/comments`,
    events_url: `${urls.api}/events`,
    html_url: urls.html,
    number: item.number,
    state: item.state,
    title: item.title,
    body: item.body,
    user: userJson(),
    labels: item.labels.map(labelJson),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: item.comments.length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.state === 'closed' ? item.updatedAt : null,
    author_association: 'OWNER',
  };
  if (item.kind === 'pr') {
    out.pull_request = { url: urls.api, html_url: urls.html, diff_url: `${urls.html}.diff`, patch_url: `${urls.html}.patch` };
  }
  return out;
}

export function pullJson(forge: Forge, repo: Repo, item: Item, origin: string): Record<string, unknown> {
  const urls = itemUrls(repo, item, origin);
  const headSha = item.head !== undefined ? (repo.refs.get(`refs/heads/${item.head.ref}`) ?? item.head.sha) : '';
  const baseSha = item.base !== undefined ? (repo.refs.get(`refs/heads/${item.base.ref}`) ?? item.base.sha) : '';
  const mergeable = item.state === 'open' ? forge.prMergeable(repo, item) : false;
  return {
    id: item.id,
    node_id: '',
    url: urls.api,
    html_url: urls.html,
    diff_url: `${urls.html}.diff`,
    patch_url: `${urls.html}.patch`,
    issue_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${item.number}`,
    number: item.number,
    state: item.state,
    locked: false,
    title: item.title,
    body: item.body,
    user: userJson(),
    labels: item.labels.map(labelJson),
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.state === 'closed' ? item.updatedAt : null,
    merged_at: item.mergedAt ?? null,
    merge_commit_sha: item.mergeCommitSha ?? null,
    merged: item.merged ?? false,
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    merged_by: null,
    draft: false,
    head: {
      label: `${repo.owner}:${item.head?.ref ?? ''}`,
      ref: item.head?.ref ?? '',
      sha: headSha,
      user: userJson(),
      repo: repoJson(repo, origin),
    },
    base: {
      label: `${repo.owner}:${item.base?.ref ?? ''}`,
      ref: item.base?.ref ?? '',
      sha: baseSha,
      user: userJson(),
      repo: repoJson(repo, origin),
    },
  };
}

export function commentJson(repo: Repo, item: Item, comment: { id: number; body: string; createdAt: string; updatedAt: string }, origin: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: '',
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${item.number}/comments/${comment.id}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${item.number}#issuecomment-${comment.id}`,
    issue_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${item.number}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseBody(req: RestRequest): Record<string, unknown> | null {
  if (req.body.length === 0) return {};
  try {
    const value = JSON.parse(req.body.toString('utf8')) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function badJson(): RestResponse {
  return err(400, 'Invalid JSON in request body');
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, origin: string, pathname: string): { page: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `${origin}${pathname}?${q.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  return { page: [...slice], link: links.length > 0 ? links.join(', ') : null };
}

function linkHeader(link: string | null): Record<string, string> | undefined {
  return link === null ? undefined : { link };
}

function wrapBase64(content: string): string {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 60) lines.push(b64.slice(i, i + 60));
  return lines.join('\n');
}

function commitDate(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return new Date().toISOString();
  const match = / (\d+) [+-]\d{4}$/.exec(parseCommit(obj.data).author);
  if (match === null) return new Date().toISOString();
  return new Date(Number(match[1]) * 1000).toISOString();
}

function commitJson(forge: Forge, repo: Repo, oid: string, origin: string): Record<string, unknown> {
  const obj = repo.objects.get(oid)!;
  const view = parseCommit(obj.data);
  const authorLine = view.author;
  const committerLine = view.committer;
  const nameOf = (line: string): string => line.replace(/ <.*$/, '');
  const emailOf = (line: string): string => {
    const m = /<([^>]*)>/.exec(line);
    return m === null ? '' : m[1]!;
  };
  return {
    sha: oid,
    node_id: '',
    commit: {
      author: { name: nameOf(authorLine), email: emailOf(authorLine), date: commitDate(repo, oid) },
      committer: { name: nameOf(committerLine), email: emailOf(committerLine), date: commitDate(repo, oid) },
      message: view.message,
      tree: { sha: view.tree, url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${view.tree}` },
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/commit/${oid}`,
    author: userJson(),
    committer: userJson(),
    parents: view.parents.map((parent) => ({
      sha: parent,
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}`,
      html_url: `${origin}/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

/** Walk a tree down to a directory path; returns its oid or null. */
function subtreeOid(repo: Repo, treeOid: string, dirPath: string): string | null {
  if (dirPath === '') return treeOid;
  let current = treeOid;
  for (const segment of dirPath.split('/')) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/** Handle a REST v3 request. Returns null when the path is not under /api/v3. */
export function handleRest(forge: Forge, req: RestRequest): RestResponse | null {
  if (!req.pathname.startsWith('/api/v3')) return null;
  const tail = req.pathname.slice('/api/v3'.length);
  const segments = tail.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });

  // -- root and meta ---------------------------------------------------------
  if (segments.length === 0) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    const o = `${req.origin}/api/v3`;
    return json(200, {
      current_user_url: `${o}/user`,
      current_user_authorizations_html_url: `${o}/authorizations`,
      authorizations_url: `${o}/authorizations`,
      code_search_url: `${o}/search/code?q={query}`,
      commit_search_url: `${o}/search/commits?q={query}`,
      emails_url: `${o}/user/emails`,
      emojis_url: `${o}/emojis`,
      events_url: `${o}/events`,
      feeds_url: `${o}/feeds`,
      followers_url: `${o}/user/followers`,
      following_url: `${o}/user/following{/other_user}`,
      gists_url: `${o}/gists{/gist_id}`,
      hub_url: `${o}/hub`,
      issue_search_url: `${o}/search/issues?q={query}`,
      issues_url: `${o}/issues`,
      keys_url: `${o}/user/keys`,
      label_search_url: `${o}/search/labels?q={query}`,
      notifications_url: `${o}/notifications`,
      organization_url: `${o}/orgs/{org}`,
      organization_repositories_url: `${o}/orgs/{org}/repos`,
      organization_teams_url: `${o}/orgs/{org}/teams`,
      public_gists_url: `${o}/gists/public`,
      rate_limit_url: `${o}/rate_limit`,
      repository_url: `${o}/repos/{owner}/{repo}`,
      repository_search_url: `${o}/search/repositories?q={query}`,
      current_user_repositories_url: `${o}/user/repos`,
      starred_url: `${o}/user/starred{/owner}{/repo}`,
      starred_gists_url: `${o}/gists/starred`,
      user_url: `${o}/users/{user}`,
      user_organizations_url: `${o}/user/orgs`,
      user_repositories_url: `${o}/users/{user}/repos`,
      user_search_url: `${o}/search/users?q={query}`,
    });
  }
  if (segments[0] === 'meta') {
    if (req.method !== 'GET') return err(404, 'Not Found');
    return json(200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
  }

  // -- /user -----------------------------------------------------------------
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (req.method !== 'GET') return err(404, 'Not Found');
      return json(200, userJson());
    }
    if (segments[1] === 'repos') {
      if (req.method === 'POST') {
        const body = parseBody(req);
        if (body === null) return badJson();
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') return err(422, 'name is required');
        const repo = forge.createRepo(name, {
          description: typeof body.description === 'string' ? body.description : '',
          isPrivate: body.private === true,
        });
        if (repo === null) return err(422, 'name already exists on this account');
        return json(201, repoJson(repo, req.origin));
      }
      if (req.method === 'GET') {
        const repos = forge.listRepos();
        const { page, link } = paginate(repos, req.query, req.origin, req.pathname);
        return json(200, page.map((repo) => repoJson(repo, req.origin)), linkHeader(link));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // -- /repos/{owner}/{repo}... ----------------------------------------------
  if (segments[0] !== 'repos' || segments.length < 3) return err(404, 'Not Found');
  const owner = segments[1]!;
  const repoName = segments[2]!;
  if (owner !== VIEWER.login) return err(404, 'Not Found');
  const repo = forge.getRepo(owner, repoName);
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (req.method === 'GET') {
      if (repo === undefined) return err(404, 'Not Found');
      return json(200, repoJson(repo, req.origin));
    }
    if (req.method === 'PATCH') {
      if (repo === undefined) return err(404, 'Not Found');
      const body = parseBody(req);
      if (body === null) return badJson();
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        if (forge.repos.has(body.name)) return err(422, 'name already exists on this account');
        forge.repos.delete(repo.name);
        repo.name = body.name;
        forge.repos.set(repo.name, repo);
      }
      repo.updatedAt = forge.stamp();
      return json(200, repoJson(repo, req.origin));
    }
    if (req.method === 'DELETE') {
      if (repo === undefined) return err(404, 'Not Found');
      forge.deleteRepo(repo.name);
      return noContent();
    }
    return err(404, 'Not Found');
  }
  if (repo === undefined) return err(404, 'Not Found');

  const repoBase = `${req.origin}/api/v3/repos/${owner}/${repo.name}`;

  // -- branches ---------------------------------------------------------------
  if (rest[0] === 'branches') {
    if (rest.length === 1) {
      if (req.method !== 'GET') return err(404, 'Not Found');
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => ({
          name: name.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(name)!, url: `${repoBase}/commits/${repo.refs.get(name)!}` },
          protected: false,
        }));
      return json(200, branches);
    }
    const branch = rest.slice(1).join('/');
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (req.method !== 'GET' || tip === undefined) return err(404, 'Not Found');
    return json(200, {
      name: branch,
      commit: { sha: tip, url: `${repoBase}/commits/${tip}` },
      protected: false,
    });
  }

  // -- git refs ---------------------------------------------------------------
  if (rest[0] === 'git' && rest[1] === 'refs') {
    const refPath = rest.slice(2).join('/');
    if (refPath === '') {
      if (req.method === 'POST') {
        const body = parseBody(req);
        if (body === null) return badJson();
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/')) return err(422, 'Invalid ref');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!isOid(sha) || !repo.objects.has(sha)) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        const type = repo.objects.get(sha)!.type;
        return json(201, { ref, node_id: '', url: `${repoBase}/git/refs/${ref}`, object: { sha, type, url: `${repoBase}/git/${type}s/${sha}` } });
      }
      if (req.method === 'GET') {
        const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({
          ref,
          node_id: '',
          url: `${repoBase}/git/refs/${ref}`,
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${repoBase}/git/commits/${sha}` },
        }));
        return json(200, refs);
      }
      return err(404, 'Not Found');
    }
    const ref = refPath;
    if (req.method === 'GET') {
      const sha = repo.refs.get(ref);
      if (sha === undefined) return err(404, 'Not Found');
      const type = repo.objects.get(sha)?.type ?? 'commit';
      return json(200, { ref, node_id: '', url: `${repoBase}/git/refs/${ref}`, object: { sha, type, url: `${repoBase}/git/${type}s/${sha}` } });
    }
    if (req.method === 'DELETE') {
      if (!repo.refs.has(ref)) return err(404, 'Not Found');
      repo.refs.delete(ref);
      return noContent();
    }
    return err(404, 'Not Found');
  }

  // -- commits ----------------------------------------------------------------
  if (rest[0] === 'commits') {
    if (rest.length === 1) {
      if (req.method !== 'GET') return err(404, 'Not Found');
      if (repo.refs.size === 0) return err(409, 'Git Repository is empty.');
      const refish = req.query.get('sha') ?? repo.defaultBranch;
      const tip = forge.resolveRef(repo, refish);
      if (tip === null) return err(404, 'Not Found');
      const list = forge.commitList(repo, tip);
      const { page, link } = paginate(list, req.query, req.origin, req.pathname);
      return json(200, page.map((oid) => commitJson(forge, repo, oid, req.origin)), linkHeader(link));
    }
    if (req.method !== 'GET') return err(404, 'Not Found');
    const sha = rest[1]!;
    const resolved = forge.resolveRef(repo, sha);
    if (resolved === null) return err(404, 'Not Found');
    return json(200, commitJson(forge, repo, forge.peelToCommit(repo, resolved), req.origin));
  }

  // -- contents ---------------------------------------------------------------
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).join('/');
    const refish = req.query.get('ref') ?? repo.defaultBranch;
    if (req.method === 'GET') {
      const tip = forge.resolveRef(repo, refish);
      if (tip === null) return err(404, 'Not Found');
      const flat = forge.flatAt(repo, tip);
      const entry = flat.get(filePath);
      if (entry !== undefined) {
        const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          content: wrapBase64(data.toString('utf8')),
          sha: entry.oid,
          url: `${repoBase}/contents/${filePath}`,
          git_url: `${repoBase}/git/blobs/${entry.oid}`,
          html_url: `${req.origin}/${owner}/${repo.name}/blob/${refish}/${filePath}`,
          download_url: `${req.origin}/${owner}/${repo.name}/raw/${refish}/${filePath}`,
        });
      }
      const prefix = filePath === '' ? '' : `${filePath}/`;
      const children = new Map<string, { name: string; path: string; type: 'file' | 'dir'; sha: string; size?: number }>();
      for (const [path, flatEntry] of flat) {
        if (!path.startsWith(prefix)) continue;
        const restPath = path.slice(prefix.length);
        const first = restPath.split('/')[0]!;
        if (restPath.includes('/')) {
          if (!children.has(first)) {
            const dirOid = subtreeOid(repo, parseCommit(repo.objects.get(forge.peelToCommit(repo, tip))!.data).tree, filePath === '' ? first : `${filePath}/${first}`);
            children.set(first, { name: first, path: filePath === '' ? first : `${filePath}/${first}`, type: 'dir', sha: dirOid ?? '' });
          }
        } else {
          const data = repo.objects.get(flatEntry.oid)?.data ?? Buffer.alloc(0);
          children.set(first, { name: first, path, type: 'file', sha: flatEntry.oid, size: data.length });
        }
      }
      if (children.size === 0) return err(404, 'Not Found');
      return json(200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((child) => ({
        type: child.type,
        size: child.size ?? 0,
        name: child.name,
        path: child.path,
        sha: child.sha,
        url: `${repoBase}/contents/${child.path}`,
        git_url: `${repoBase}/git/${child.type === 'dir' ? 'trees' : 'blobs'}/${child.sha}`,
        html_url: `${req.origin}/${owner}/${repo.name}/${child.type === 'dir' ? 'tree' : 'blob'}/${refish}/${child.path}`,
        download_url: child.type === 'file' ? `${req.origin}/${owner}/${repo.name}/raw/${refish}/${child.path}` : null,
      })));
    }
    if (req.method === 'PUT') {
      const body = parseBody(req);
      if (body === null) return badJson();
      const message = typeof body.message === 'string' ? body.message : '';
      const contentB64 = typeof body.content === 'string' ? body.content : '';
      if (message === '' || contentB64 === '') return err(422, 'message and content are required');
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      const flat = forge.flatAt(repo, tip ?? null);
      const existing = flat.get(filePath);
      const isUpdate = existing !== undefined;
      if (isUpdate) {
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (sha === '') return err(422, 'sha is required to update a file');
        if (sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
      }
      const commitOid = forge.commitChanges(repo, { branch, message, changes: [{ path: filePath, data }] });
      const blobOid = forge.putObject(repo, 'blob', data);
      return json(isUpdate ? 200 : 201, {
        content: {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: blobOid,
          size: data.length,
          url: `${repoBase}/contents/${filePath}`,
          html_url: `${req.origin}/${owner}/${repo.name}/blob/${branch}/${filePath}`,
          git_url: `${repoBase}/git/blobs/${blobOid}`,
          download_url: `${req.origin}/${owner}/${repo.name}/raw/${branch}/${filePath}`,
          type: 'file',
          content: wrapBase64(data.toString('utf8')),
          encoding: 'base64',
        },
        commit: { sha: commitOid, message, author: userJson(), committer: userJson() },
      });
    }
    if (req.method === 'DELETE') {
      const body = parseBody(req);
      if (body === null) return badJson();
      const message = typeof body.message === 'string' ? body.message : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return err(404, 'Not Found');
      const flat = forge.flatAt(repo, tip);
      const existing = flat.get(filePath);
      if (existing === undefined) return err(404, 'Not Found');
      if (sha !== '' && sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
      const commitOid = forge.commitChanges(repo, { branch, message, changes: [{ path: filePath, data: null }] });
      return json(200, { commit: { sha: commitOid, message, author: userJson(), committer: userJson() } });
    }
    return err(404, 'Not Found');
  }

  // -- labels -----------------------------------------------------------------
  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (req.method === 'GET') {
        return json(200, [...repo.labels.values()].map(labelJson));
      }
      if (req.method === 'POST') {
        const body = parseBody(req);
        if (body === null) return badJson();
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') return err(422, 'name is required');
        if (repo.labels.has(name.toLowerCase())) return err(422, 'Label already exists');
        const label = forge.getOrCreateLabel(repo, name, typeof body.color === 'string' ? body.color : 'ededed');
        if (typeof body.description === 'string') label.description = body.description;
        return json(201, labelJson(label));
      }
      return err(404, 'Not Found');
    }
    if (req.method !== 'GET') return err(404, 'Not Found');
    const label = repo.labels.get(decodeURIComponent(rest[1]!).toLowerCase());
    if (label === undefined) return err(404, 'Not Found');
    return json(200, labelJson(label));
  }

  // -- issues -----------------------------------------------------------------
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (req.method === 'POST') {
        const body = parseBody(req);
        if (body === null) return badJson();
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') return err(422, 'title is required');
        const labels: Label[] = [];
        if (Array.isArray(body.labels)) {
          for (const raw of body.labels) {
            const name = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).name : undefined;
            if (typeof name !== 'string') continue;
            const label = repo.labels.get(name.toLowerCase());
            if (label === undefined) return err(422, `Label does not exist: ${name}`);
            labels.push(label);
          }
        }
        const item = forge.newItem(repo, 'issue', {
          title,
          body: typeof body.body === 'string' ? body.body : '',
          labels,
        });
        return json(201, issueJson(repo, item, req.origin));
      }
      if (req.method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        let items = [...repo.items.values()];
        if (state === 'open') items = items.filter((item) => item.state === 'open');
        else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
        const key = sort === 'updated' ? 'updatedAt' : 'createdAt';
        items.sort((a, b) => {
          const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : a.number - b.number;
          return direction === 'asc' ? cmp : -cmp;
        });
        const { page, link } = paginate(items, req.query, req.origin, req.pathname);
        return json(200, page.map((item) => issueJson(repo, item, req.origin)), linkHeader(link));
      }
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const item = repo.items.get(number);
    if (rest.length === 2) {
      if (req.method === 'GET') {
        if (item === undefined) return err(404, 'Not Found');
        return json(200, issueJson(repo, item, req.origin));
      }
      if (req.method === 'PATCH') {
        if (item === undefined) return err(404, 'Not Found');
        const body = parseBody(req);
        if (body === null) return badJson();
        if (typeof body.title === 'string') item.title = body.title;
        if (typeof body.body === 'string') item.body = body.body;
        if (body.state === 'open' || body.state === 'closed') item.state = body.state;
        if (Array.isArray(body.labels)) {
          const labels: Label[] = [];
          for (const raw of body.labels) {
            const name = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).name : undefined;
            if (typeof name !== 'string') continue;
            const label = repo.labels.get(name.toLowerCase());
            if (label === undefined) return err(422, `Label does not exist: ${name}`);
            labels.push(label);
          }
          item.labels = labels;
        }
        item.updatedAt = forge.stamp();
        return json(200, issueJson(repo, item, req.origin));
      }
      return err(404, 'Not Found');
    }
    if (rest[2] === 'comments') {
      if (item === undefined) return err(404, 'Not Found');
      if (req.method === 'GET') {
        return json(200, item.comments.map((comment) => commentJson(repo, item, comment, req.origin)));
      }
      if (req.method === 'POST') {
        const body = parseBody(req);
        if (body === null) return badJson();
        if (typeof body.body !== 'string' || body.body === '') return err(422, 'body is required');
        const now = forge.stamp();
        const comment = { id: forge.nextId(), body: body.body, createdAt: now, updatedAt: now };
        item.comments.push(comment);
        item.updatedAt = forge.stamp();
        return json(201, commentJson(repo, item, comment, req.origin));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // -- pulls ------------------------------------------------------------------
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (req.method === 'POST') {
        const body = parseBody(req);
        if (body === null) return badJson();
        const title = typeof body.title === 'string' ? body.title : '';
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : '';
        if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
        const headTip = repo.refs.get(`refs/heads/${head}`);
        const baseTip = repo.refs.get(`refs/heads/${base}`);
        if (headTip === undefined) return err(422, `Head branch does not exist: ${head}`);
        if (baseTip === undefined) return err(422, `Base branch does not exist: ${base}`);
        if (headTip === baseTip || forge.isAncestor(repo, headTip, baseTip)) {
          return err(422, 'No commits between base and head');
        }
        for (const existing of repo.items.values()) {
          if (existing.kind === 'pr' && existing.state === 'open' && existing.head?.ref === head && existing.base?.ref === base) {
            return err(422, 'A pull request already exists for this head and base');
          }
        }
        const item = forge.newItem(repo, 'pr', {
          title,
          body: typeof body.body === 'string' ? body.body : '',
          head: { ref: head, sha: headTip },
          base: { ref: base, sha: baseTip },
        });
        return json(201, pullJson(forge, repo, item, req.origin));
      }
      if (req.method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let items = [...repo.items.values()].filter((item) => item.kind === 'pr');
        if (state === 'open') items = items.filter((item) => item.state === 'open');
        else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
        items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        const { page, link } = paginate(items, req.query, req.origin, req.pathname);
        return json(200, page.map((item) => pullJson(forge, repo, item, req.origin)), linkHeader(link));
      }
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const item = repo.items.get(number);
    if (item === undefined || item.kind !== 'pr') return err(404, 'Not Found');
    if (rest.length === 2) {
      if (req.method !== 'GET') return err(404, 'Not Found');
      return json(200, pullJson(forge, repo, item, req.origin));
    }
    if (rest[2] === 'files') {
      if (req.method !== 'GET') return err(404, 'Not Found');
      const baseTip = repo.refs.get(`refs/heads/${item.base!.ref}`);
      const mergeBase = baseTip === undefined ? null : forge.mergeBase(repo, item.head!.sha, baseTip);
      const baseFlat = forge.flatAt(repo, mergeBase);
      const headFlat = forge.flatAt(repo, item.head!.sha);
      const files = forge.diffFiles(baseFlat, headFlat, repo).map((file) => ({
        sha: headFlat.get(file.filename)?.oid ?? baseFlat.get(file.filename)?.oid ?? '',
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: '',
        raw_url: '',
        contents_url: '',
        patch: '',
      }));
      return json(200, files);
    }
    if (rest[2] === 'merge') {
      if (req.method !== 'PUT') return err(404, 'Not Found');
      const body = parseBody(req);
      if (body === null) return badJson();
      if (item.merged === true) return err(405, 'Pull request already merged');
      if (item.state === 'closed') return err(405, 'Pull request is closed');
      const methodRaw = typeof body.merge_method === 'string' ? body.merge_method.toLowerCase() : 'squash';
      const method = methodRaw === 'merge' ? 'merge' : methodRaw === 'rebase' ? 'rebase' : 'squash';
      const result = forge.mergePr(repo, item, method);
      if ('error' in result) return err(405, result.error === 'merge conflict' ? 'Merge conflict' : result.error);
      return json(200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
