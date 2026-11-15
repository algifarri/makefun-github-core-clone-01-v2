// store.ts — the forge's single shared in-memory store.
//
// One Forge holds every repository, its git objects and refs, and its
// issues and pull requests (one shared numbering, as on GitHub). The git
// smart-HTTP surface, REST v3, GraphQL and MCP all read and write this
// one store, so a commit pushed over git shows up in REST and GraphQL at
// once, and an issue created over MCP is the same object REST lists.
//
// Nothing here touches the network or the disk. Timestamps come from a
// monotonically increasing counter seeded at process start, so creation
// order is stable even when two items are created in the same millisecond.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// git object shapes
// ---------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headText = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as `name/`. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headText = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of headText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// the viewer and global ids
// ---------------------------------------------------------------------------

/** The one user the token names; every repository belongs to this login. */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** An opaque Relay-style global id: base64url of `Kind:segment:segment...`. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

/** Decode a global id back into its kind and segments, or null when malformed. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
}

// ---------------------------------------------------------------------------
// repository model
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  default: boolean;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Item {
  kind: 'issue' | 'pr';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  head?: { ref: string; sha: string };
  base?: { ref: string; sha: string };
  merged?: boolean;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  items: Map<number, Item>;
  nextNumber: number;
  labelSeq: number;
}

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** A line-diff summary for one changed file. */
export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 700000;
  private nextObjectId = 900000;
  private clockBase = Date.now();
  private clockTick = 0;

  /** A strictly increasing ISO timestamp, so creation order is unambiguous. */
  stamp(): string {
    this.clockTick += 1;
    return new Date(this.clockBase + this.clockTick).toISOString();
  }

  /** The next REST-visible numeric id (issues, pull requests, comments, labels). */
  nextId(): number {
    this.nextObjectId += 1;
    return this.nextObjectId;
  }

  // -- repositories ----------------------------------------------------------

  createRepo(name: string, opts: { description?: string; isPrivate?: boolean }): Repo | null {
    if (this.repos.has(name)) return null;
    const now = this.stamp();
    this.nextRepoId += 1;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER.login,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      labelSeq: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** A repository only exists under the viewer's login; any other owner is a miss. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  // -- git objects -----------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Peel a tag object to the commit it names (or return the oid unchanged). */
  peelToCommit(repo: Repo, oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 8; depth += 1) {
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'tag') return current;
      current = parseTag(obj.data).object;
    }
    return current;
  }

  // -- refs ------------------------------------------------------------------

  /** Resolve a branch name, full ref, HEAD, or full/unique-prefix sha to a commit oid. */
  resolveRef(repo: Repo, refish: string): string | null {
    if (refish === 'HEAD') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ?? null;
    }
    if (refish.startsWith('refs/')) {
      return repo.refs.get(refish) ?? null;
    }
    const branchTip = repo.refs.get(`refs/heads/${refish}`);
    if (branchTip !== undefined) return branchTip;
    const tagTip = repo.refs.get(`refs/tags/${refish}`);
    if (tagTip !== undefined) return this.peelToCommit(repo, tagTip);
    if (isOid(refish)) {
      return repo.objects.has(refish) ? refish : null;
    }
    if (/^[0-9a-f]{4,39}$/.test(refish)) {
      const matches = [...repo.objects.keys()].filter((oid) => oid.startsWith(refish));
      if (matches.length === 1) return matches[0];
    }
    return null;
  }

  refTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  // -- commit graph ----------------------------------------------------------

  /** Commits reachable from `tip`, newest first (depth-first, parents after the child). */
  commitList(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [this.peelToCommit(repo, tip)];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.push(oid);
      const view = parseCommit(obj.data);
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i]!);
    }
    return out;
  }

  /** Every commit reachable from `tip` (as a set). */
  reachableCommits(repo: Repo, tip: string): Set<string> {
    return new Set(this.commitList(repo, tip));
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const target = this.peelToCommit(repo, ancestor);
    // Reachability with an early exit: walk the descendant's history and
    // stop the moment the target commit is met, instead of collecting
    // every reachable commit first. The answer is the same membership
    // question reachableCommits answers, asked lazily — a fast-forward
    // check (the receive-pack hot path) finds its answer in a step or
    // two instead of a full-history walk per push.
    const seen = new Set<string>();
    const stack: string[] = [this.peelToCommit(repo, descendant)];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      if (oid === target) return true;
      const view = parseCommit(obj.data);
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i]!);
    }
    return false;
  }

  /** The nearest common ancestor of two commits, or null when unrelated. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aSet = this.reachableCommits(repo, a);
    const queue: string[] = [this.peelToCommit(repo, b)];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aSet.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    return null;
  }

  /** The timestamp embedded in a commit's author line, or 0 when unparseable. */
  commitTime(repo: Repo, oid: string): number {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return 0;
    const match = / (\d+) [+-]\d{4}$/.exec(parseCommit(obj.data).author);
    return match === null ? 0 : Number(match[1]);
  }

  // -- trees -----------------------------------------------------------------

  /** Flatten a tree into path -> {mode, oid}, following subtrees. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        this.flattenTree(repo, entry.oid, path, out);
      } else {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
    return out;
  }

  /** Build (and store) the tree objects for a flat path map; returns the root tree oid. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, FlatEntry>): string {
    interface Node {
      files: Map<string, FlatEntry>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The flat file map at a commit (empty when the repo has no such commit). */
  flatAt(repo: Repo, commitOid: string | null): Map<string, FlatEntry> {
    if (commitOid === null) return new Map();
    const obj = repo.objects.get(this.peelToCommit(repo, commitOid));
    if (obj === undefined || obj.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(obj.data).tree);
  }

  // -- contents commits ------------------------------------------------------

  /**
   * Commit file changes on a branch: `changes` maps a path to new bytes, or
   * null to delete it. A missing branch is created from the default tip; an
   * unborn repository takes a root commit. The message is stored exactly as
   * given. Returns the new commit oid.
   */
  commitChanges(
    repo: Repo,
    opts: { branch: string; message: string; changes: Array<{ path: string; data: Buffer | null }> },
  ): string {
    const branchRef = `refs/heads/${opts.branch}`;
    let tip = repo.refs.get(branchRef);
    if (tip === undefined && opts.branch !== repo.defaultBranch) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const flat = this.flatAt(repo, tip ?? null);
    for (const change of opts.changes) {
      if (change.data === null) flat.delete(change.path);
      else flat.set(change.path, { mode: '100644', oid: this.putObject(repo, 'blob', change.data) });
    }
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const now = Math.floor(Date.now() / 1000);
    const who = `${VIEWER.name} <${VIEWER.email}> ${now} +0000`;
    const lines = [`tree ${treeOid}`];
    if (tip !== undefined) lines.push(`parent ${tip}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    const data = Buffer.from(`${lines.join('\n')}\n${opts.message}`, 'utf8');
    const commitOid = this.putObject(repo, 'commit', data);
    repo.refs.set(branchRef, commitOid);
    return commitOid;
  }

  // -- merge & diff ----------------------------------------------------------

  /** Three-way merge of flat maps; returns the merged map and conflicting paths. */
  threeWayMerge(
    base: Map<string, FlatEntry>,
    ours: Map<string, FlatEntry>,
    theirs: Map<string, FlatEntry>,
  ): { merged: Map<string, FlatEntry>; conflicts: string[] } {
    const merged = new Map<string, FlatEntry>();
    const conflicts: string[] = [];
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (a?: FlatEntry, c?: FlatEntry): boolean => (a === undefined && c === undefined) || (a !== undefined && c !== undefined && a.oid === c.oid);
      if (same(o, t)) {
        if (o !== undefined) merged.set(path, o);
      } else if (same(b, o)) {
        if (t !== undefined) merged.set(path, t);
      } else if (same(b, t)) {
        if (o !== undefined) merged.set(path, o);
      } else {
        conflicts.push(path);
      }
    }
    return { merged, conflicts };
  }

  /** Count added/removed lines between two texts with a simple LCS. */
  lineDiff(before: string, after: string): { additions: number; deletions: number } {
    const a = before === '' ? [] : before.split('\n');
    const b = after === '' ? [] : after.split('\n');
    if (a.length === 0 && b.length === 0) return { additions: 0, deletions: 0 };
    const n = a.length;
    const m = b.length;
    // LCS over a bounded table; file contents here are small.
    const prev = new Array<number>(m + 1).fill(0);
    const curr = new Array<number>(m + 1).fill(0);
    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      for (let j = 0; j <= m; j += 1) prev[j] = curr[j]!;
    }
    const common = prev[m]!;
    return { additions: m - common, deletions: n - common };
  }

  /** Diff two flat maps into per-file change records (merge-base -> head). */
  diffFiles(base: Map<string, FlatEntry>, head: Map<string, FlatEntry>, repo: Repo): FileDiff[] {
    const out: FileDiff[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) {
        const text = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const lines = text === '' ? 0 : text.split('\n').length;
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b !== undefined && h === undefined) {
        const text = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const lines = text === '' ? 0 : text.split('\n').length;
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const before = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const after = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const counts = this.lineDiff(before, after);
        out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
      }
    }
    return out;
  }

  /** Whether a pull request merges cleanly (no three-way conflicts). */
  prMergeable(repo: Repo, item: Item): boolean {
    if (item.kind !== 'pr' || item.head === undefined || item.base === undefined) return false;
    const baseTip = repo.refs.get(`refs/heads/${item.base.ref}`);
    if (baseTip === undefined) return false;
    const mergeBase = this.mergeBase(repo, item.head.sha, baseTip);
    if (mergeBase === null) return false;
    const { conflicts } = this.threeWayMerge(
      this.flatAt(repo, mergeBase),
      this.flatAt(repo, baseTip),
      this.flatAt(repo, item.head.sha),
    );
    return conflicts.length === 0;
  }

  /**
   * Merge a pull request. `squash` makes one commit (parent = base tip, its
   * message names the pull request's title); `merge` makes a two-parent
   * commit; `rebase` is treated as squash. Returns the merge commit oid,
   * or null with a reason when it cannot merge.
   */
  mergePr(repo: Repo, item: Item, method: 'squash' | 'merge' | 'rebase'): { sha: string } | { error: string } {
    if (item.kind !== 'pr' || item.head === undefined || item.base === undefined) return { error: 'not a pull request' };
    const baseRef = `refs/heads/${item.base.ref}`;
    const baseTip = repo.refs.get(baseRef);
    if (baseTip === undefined) return { error: 'base branch does not exist' };
    const headTip = item.head.sha;
    const mergeBase = this.mergeBase(repo, headTip, baseTip);
    if (mergeBase === null) return { error: 'no merge base' };
    const { merged, conflicts } = this.threeWayMerge(
      this.flatAt(repo, mergeBase),
      this.flatAt(repo, baseTip),
      this.flatAt(repo, headTip),
    );
    if (conflicts.length > 0) return { error: 'merge conflict' };
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const now = Math.floor(Date.now() / 1000);
    const who = `${VIEWER.name} <${VIEWER.email}> ${now} +0000`;
    const lines = [`tree ${treeOid}`, `parent ${baseTip}`];
    let message: string;
    if (method === 'merge') {
      lines.push(`parent ${headTip}`);
      message = `Merge pull request #${item.number} from ${item.head.ref}\n\n${item.title}`;
    } else {
      message = `${item.title} (#${item.number})\n\n${item.body}`;
    }
    lines.push(`author ${who}`, `committer ${who}`, '');
    const data = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
    const commitOid = this.putObject(repo, 'commit', data);
    repo.refs.set(baseRef, commitOid);
    item.state = 'closed';
    item.merged = true;
    item.mergedAt = this.stamp();
    item.mergeCommitSha = commitOid;
    item.updatedAt = this.stamp();
    return { sha: commitOid };
  }

  // -- issues & pull requests -------------------------------------------------

  newItem(repo: Repo, kind: 'issue' | 'pr', fields: { title: string; body: string; labels?: Label[]; head?: { ref: string; sha: string }; base?: { ref: string; sha: string } }): Item {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const now = this.stamp();
    const item: Item = {
      kind,
      number,
      id: this.nextId(),
      title: fields.title,
      body: fields.body,
      state: 'open',
      labels: fields.labels ?? [],
      createdAt: now,
      updatedAt: now,
      comments: [],
      head: fields.head,
      base: fields.base,
      merged: kind === 'pr' ? false : undefined,
      mergedAt: kind === 'pr' ? null : undefined,
      mergeCommitSha: kind === 'pr' ? null : undefined,
    };
    repo.items.set(number, item);
    return item;
  }

  getOrCreateLabel(repo: Repo, name: string, color = 'ededed'): Label {
    const key = name.toLowerCase();
    const existing = repo.labels.get(key);
    if (existing !== undefined) return existing;
    const label: Label = {
      id: this.nextId(),
      name,
      color: color.replace(/^#/, '').toLowerCase(),
      default: name === 'bug',
      description: '',
    };
    repo.labels.set(key, label);
    return label;
  }
}
