// githttp.ts — git smart HTTP: info/refs, upload-pack (v0 and v2) and
// receive-pack, over the shared Forge store. No authentication on any
// git endpoint; a missing repository answers 404.
//
// Protocol notes that matter here:
//  - a v2 fetch answer frames its sections with pkt DELIMs between them
//    (acknowledgments, shallow-info, packfile), and the packfile section
//    is sideband band 1 carrying the pack's RAW bytes — never a pkt-line
//    stream re-encoded inside the band;
//  - a receive-pack answer wraps its report-status stream in sideband
//    band 1, with a flush inside the band and a flush outside it;
//  - a shallow fetch cuts the commit walk off at the requested depth,
//    so a depth-1 clone carries the tip only and names it in shallow-info.

import {
  DELIM,
  FLUSH,
  PktDecoder,
  decodePktLines,
  encodePktLines,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
} from './git.ts';
import {
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type Forge,
  type GitObject,
  type Repo,
} from './store.ts';

export interface GitRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'makefun-forge/1.0.0';

const UPLOAD_CAPS =
  'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative symref=HEAD:refs/heads/main agent=' + AGENT;
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta quiet atomic agent=' + AGENT;

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
}

function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** Every advertised ref of a repo, HEAD first, then heads, then tags. */
function advertisedRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (mainTip !== undefined) out.push({ name: 'HEAD', oid: mainTip });
  const heads = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
  for (const name of heads) {
    const oid = repo.refs.get(name)!;
    out.push({ name, oid });
  }
  const tags = [...repo.refs.keys()].filter((name) => name.startsWith('refs/tags/')).sort();
  for (const name of tags) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') entry.peeled = repoPeel(repo, oid);
    out.push(entry);
    if (entry.peeled !== undefined) out.push({ name: `${name}^{}`, oid: entry.peeled });
  }
  return out;
}

function repoPeel(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

/** A v0 ref advertisement: service preamble, refs, capabilities on the first line. */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const refs = advertisedRefs(repo);
  const lines: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const text = `${ref.oid} ${ref.name}\n`;
      lines.push(index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : text);
    });
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** A v2 capability advertisement (upload-pack only). */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------
// pack planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

function collectTreeObjects(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  if (!out.has(treeOid)) out.set(treeOid, obj);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') {
      collectTreeObjects(repo, entry.oid, out);
    } else {
      const blob = repo.objects.get(entry.oid);
      if (blob !== undefined && !out.has(entry.oid)) out.set(entry.oid, blob);
    }
  }
}

/**
 * The objects a client already owns from one of its haves: the commit and
 * its tree closure, plus its ancestors — but the walk stops at a shallow
 * boundary, whose parents the client does not have.
 */
function haveClosureOf(repo: Repo, oid: string, clientShallow: Set<string>, out: Map<string, GitObject>): void {
  const obj = repo.objects.get(oid);
  if (obj === undefined || out.has(oid)) return;
  out.set(oid, obj);
  if (obj.type === 'commit') {
    collectTreeObjects(repo, parseCommit(obj.data).tree, out);
    if (!clientShallow.has(oid)) {
      for (const parent of parseCommit(obj.data).parents) haveClosureOf(repo, parent, clientShallow, out);
    }
  } else if (obj.type === 'tag') {
    haveClosureOf(repo, parseTag(obj.data).object, clientShallow, out);
  } else if (obj.type === 'tree') {
    collectTreeObjects(repo, oid, out);
  }
}

/**
 * Which commits (and their trees) a fetch delivers: the wants' reachable
 * commits, stopping at the client's haves, at deepen-not exclusions, at
 * the depth cutoff, and at commits older than deepen-since. Commits whose
 * parent was cut off are the shallow boundary.
 */
function planFetch(
  forge: Forge,
  repo: Repo,
  opts: {
    wants: string[];
    haves: string[];
    clientShallow: string[];
    depth?: number;
    deepenSince?: number;
    deepenNot?: string[];
  },
): FetchPlan {
  const haves = new Set(opts.haves);
  const clientShallow = new Set(opts.clientShallow);
  const excluded = new Set<string>();
  for (const ref of opts.deepenNot ?? []) {
    const tip = forge.resolveRef(repo, ref);
    if (tip !== null) for (const oid of forge.reachableCommits(repo, tip)) excluded.add(oid);
  }

  const included = new Set<string>();
  const boundary = new Set<string>();
  const traversedShallow = new Set<string>();
  const tagObjects = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of opts.wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      tagObjects.add(want);
      queue.push({ oid: forge.peelToCommit(repo, want), dist: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, dist: 0 });
    } else {
      tagObjects.add(want);
    }
  }
  // A fetch is depth-limited when the client asked for a depth or a
  // deepen-since cutoff; only then does a shallow boundary exist.
  const depthLimited = opts.depth !== undefined || opts.deepenSince !== undefined;
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (seen.has(oid) || included.has(oid)) continue;
    seen.add(oid);
    if (excluded.has(oid)) continue;
    const isClientShallow = clientShallow.has(oid);
    // A commit the client fully has stops the walk: everything below it
    // is already on the client. A commit the client has only as a shallow
    // boundary is different — the client owns the commit but not its
    // parents, so the walk must continue through it without re-sending it.
    // That is exactly what deepening a shallow clone asks for.
    if (haves.has(oid) && !isClientShallow) continue;
    if (opts.depth !== undefined && dist >= opts.depth) continue;
    if (opts.deepenSince !== undefined && forge.commitTime(repo, oid) < opts.deepenSince) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (isClientShallow) traversedShallow.add(oid);
    else included.add(oid);
    const parents = parseCommit(obj.data).parents;
    let cut = false;
    for (const parent of parents) {
      const beyondDepth = opts.depth !== undefined && dist + 1 >= opts.depth;
      const tooOld = opts.deepenSince !== undefined && forge.commitTime(repo, parent) < opts.deepenSince;
      if (excluded.has(parent) || beyondDepth || tooOld) {
        cut = true;
      } else if (haves.has(parent) && !clientShallow.has(parent)) {
        // The parent is fully present on the client: the walk stops here,
        // but this commit is not a shallow boundary — its history continues
        // on the client side.
      } else {
        queue.push({ oid: parent, dist: dist + 1 });
      }
    }
    if (depthLimited && !isClientShallow && (cut || parents.length === 0)) boundary.add(oid);
  }

  const shallow = [...boundary];
  const unshallow: string[] = [];
  for (const oid of traversedShallow) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (parseCommit(obj.data).parents.some((parent) => included.has(parent))) unshallow.push(oid);
  }

  // What the client already owns: the closure of its haves, but never
  // across a shallow boundary — a shallow commit's parents are not on
  // the client, so their objects must stay in the pack.
  const haveClosure = new Map<string, GitObject>();
  for (const have of haves) haveClosureOf(repo, have, clientShallow, haveClosure);

  const send = new Map<string, GitObject>();
  for (const oid of tagObjects) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) send.set(oid, obj);
  }
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    send.set(oid, obj);
    collectTreeObjects(repo, parseCommit(obj.data).tree, send);
  }
  for (const oid of haveClosure.keys()) send.delete(oid);
  return { objects: send, shallow, unshallow };
}

/** Split a pack into sideband band-1 pkt-lines (raw bytes, never re-framed). */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const max = 65500;
  for (let offset = 0; offset < pack.length; offset += max) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + max));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const hasRefs = repo.refs.size > 0;
  if (!hasRefs) {
    if (unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  } else {
    if (keep('HEAD') && mainTip !== undefined) {
      lines.push(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    for (const ref of advertisedRefs(repo)) {
      if (ref.name === 'HEAD') continue;
      if (!keep(ref.name)) continue;
      if (ref.name.endsWith('^{}')) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function handleFetchV2(forge: Forge, repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  let deepenSince: number | undefined;
  const deepenNot: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isFinite(n)) depth = n;
    } else if (arg.startsWith('deepen-since ')) {
      const n = Number(arg.slice(13).trim());
      if (Number.isFinite(n)) deepenSince = n;
    } else if (arg.startsWith('deepen-not ')) deepenNot.push(arg.slice(11).trim());
  }
  const plan = planFetch(forge, repo, { wants, haves, clientShallow, depth, deepenSince, deepenNot });
  const pack = writePack(plan.objects.values());
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(forge: Forge, repo: Repo, body: Buffer): Buffer {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    throw new Error('malformed pkt-line stream');
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  let deepenSince: number | undefined;
  const deepenNot: string[] = [];
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        wants.push(rest.split(' ')[0]!);
      } else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isFinite(n)) depth = n;
      } else if (line.startsWith('deepen-since ')) {
        const n = Number(line.slice(13).trim());
        if (Number.isFinite(n)) deepenSince = n;
      } else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  const plan = planFetch(forge, repo, { wants, haves, clientShallow, depth, deepenSince, deepenNot });
  const pack = writePack(plan.objects.values());
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPack(forge: Forge, repo: Repo, req: GitRequest): GitResponse {
  const wantsV2 = req.headers['git-protocol'] === 'version=2';
  if (!wantsV2) {
    let body: Buffer;
    try {
      body = handleFetchV0(forge, repo, req.body);
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'malformed request');
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
  }
  let packets;
  try {
    packets = decodePktLines(req.body);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'malformed pkt-line stream');
  }
  let command: string | null = null;
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (command === null) {
      command = line;
    } else if (pastDelim) {
      args.push(line);
    }
  }
  if (command === null) return badRequest('empty upload-pack request');
  if (command.startsWith('command=ls-refs')) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, args) };
  }
  if (command.startsWith('command=fetch')) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV2(forge, repo, args) };
  }
  return badRequest(`unknown upload-pack command ${JSON.stringify(command)}`);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function sidebandReport(inner: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const max = 65500;
  for (let offset = 0; offset < inner.length; offset += max) {
    const slice = inner.subarray(offset, Math.min(inner.length, offset + max));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function handleReceivePack(forge: Forge, repo: Repo, req: GitRequest): GitResponse {
  const decoder = new PktDecoder();
  decoder.push(req.body);
  decoder.finish();
  const commands: PushCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    for (;;) {
      const packet = decoder.next();
      if (packet === null) break;
      if (packet.kind === 'flush') {
        packBytes = decoder.takeBuffered();
        break;
      }
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'malformed pkt-line stream');
  }

  const reportLines: Array<string | 'flush'> = [];
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
      reportLines.push('unpack ok\n');
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unpack failed';
      reportLines.push(`unpack ${detail}\n`);
      for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
      reportLines.push('flush');
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-result',
        body: sidebandReport(encodePktLines(reportLines)),
      };
    }
  } else {
    reportLines.push('unpack ok\n');
  }

  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let problem: string | null = null;
    if (command.newOid === ZERO_OID) {
      if (current === undefined) problem = 'no such ref';
      else if (command.ref === defaultRef) problem = 'cannot delete the default branch';
      else if (command.oldOid !== current) problem = 'stale info';
    } else if (command.oldOid === ZERO_OID) {
      if (current !== undefined) problem = 'already exists';
      else if (!repo.objects.has(command.newOid)) problem = 'object not found';
    } else {
      if (current === undefined) problem = 'stale info';
      else if (command.oldOid !== current) problem = 'stale info';
      else if (!repo.objects.has(command.newOid)) problem = 'object not found';
      else {
        const oldPeeled = forge.peelToCommit(repo, current);
        const newPeeled = forge.peelToCommit(repo, command.newOid);
        const oldObj = repo.objects.get(oldPeeled);
        const newObj = repo.objects.get(newPeeled);
        if (oldObj?.type === 'commit' && newObj?.type === 'commit' && !forge.isAncestor(repo, oldPeeled, newPeeled)) {
          problem = 'non-fast-forward';
        }
      }
    }
    if (problem !== null) {
      reportLines.push(`ng ${command.ref} ${problem}\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  reportLines.push('flush');
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: sidebandReport(encodePktLines(reportLines)),
  };
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * Handle a git smart-HTTP request. Returns null when the path is not a
 * git route at all (the caller then answers 404 its own way).
 */
export function handleGit(forge: Forge, req: GitRequest): GitResponse | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(req.pathname);
  if (match === null) return null;
  const owner = decodeURIComponent(match[1]!);
  const repoName = decodeURIComponent(match[2]!);
  const suffix = match[3] ?? '';
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound();

  if (req.method === 'GET' && suffix === '/info/refs') {
    const service = req.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return badRequest('unknown service');
    const wantsV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(service, repo);
    return { status: 200, contentType: `application/x-${service}-advertisement`, body };
  }
  if (req.method === 'POST' && suffix === '/git-upload-pack') {
    return handleUploadPack(forge, repo, req);
  }
  if (req.method === 'POST' && suffix === '/git-receive-pack') {
    return handleReceivePack(forge, repo, req);
  }
  return notFound();
}
