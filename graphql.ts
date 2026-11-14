// graphql.ts — a small hand-written GraphQL v4 subset: parser and
// executor over the shared Forge store.
//
// The parser handles what gh and github-mcp-server actually send:
// named or anonymous queries and mutations, variables with defaults,
// string/int/bool/enum/list/input-object/null/variable arguments, aliases,
// nested selections, inline fragments, fragment spreads, and directives
// (parsed, then ignored). The executor walks a hand-written field table
// per type; an unknown field is a 200 with an `errors` entry naming it,
// never an HTTP error.

import {
  decodeGlobalId,
  globalId,
  VIEWER,
  type Forge,
  type Item,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldSelection {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selections: Selection[];
}

interface SpreadSelection {
  kind: 'spread';
  name: string;
}

interface InlineSelection {
  kind: 'inline';
  typeCondition?: string;
  selections: Selection[];
}

type Selection = FieldSelection | SpreadSelection | InlineSelection;

interface VarDef {
  name: string;
  defaultValue?: ValueNode;
}

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  varDefs: VarDef[];
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class ParseError extends Error {}

class Lexer {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos]!)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  peek(): string {
    this.skipIgnored();
    return this.text[this.pos] ?? '';
  }

  peekWord(): string {
    this.skipIgnored();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    return match === null ? '' : match[0];
  }

  expect(ch: string): void {
    this.skipIgnored();
    if (this.text[this.pos] !== ch) throw new ParseError(`expected ${JSON.stringify(ch)} at ${this.pos}`);
    this.pos += 1;
  }

  tryConsume(ch: string): boolean {
    this.skipIgnored();
    if (this.text[this.pos] === ch) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  tryConsumeWord(word: string): boolean {
    this.skipIgnored();
    if (this.text.startsWith(word, this.pos)) {
      const after = this.text[this.pos + word.length] ?? '';
      if (/[A-Za-z0-9_]/.test(after)) return false;
      this.pos += word.length;
      return true;
    }
    return false;
  }

  readName(): string {
    this.skipIgnored();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (match === null) throw new ParseError(`expected a name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  readString(): string {
    this.skipIgnored();
    if (this.text[this.pos] !== '"') throw new ParseError(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) throw new ParseError('unterminated string');
      const ch = this.text[this.pos]!;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.text[this.pos]!;
        this.pos += 1;
        if (esc === 'u') {
          const hex = this.text.slice(this.pos, this.pos + 4);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 4;
        } else {
          out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
        }
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  readNumber(): ValueNode {
    this.skipIgnored();
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (match === null) throw new ParseError(`expected a number at ${this.pos}`);
    this.pos += match[0].length;
    const raw = match[0];
    if (raw.includes('.') || /[eE]/.test(raw)) return { kind: 'float', value: Number(raw) };
    return { kind: 'int', value: Number(raw) };
  }

  atEnd(): boolean {
    this.skipIgnored();
    return this.pos >= this.text.length;
  }
}

function parseValue(lexer: Lexer): ValueNode {
  const ch = lexer.peek();
  if (ch === '"') return { kind: 'string', value: lexer.readString() };
  if (ch === '[') {
    lexer.expect('[');
    const items: ValueNode[] = [];
    while (!lexer.tryConsume(']')) items.push(parseValue(lexer));
    return { kind: 'list', items };
  }
  if (ch === '{') {
    lexer.expect('{');
    const fields: Array<{ name: string; value: ValueNode }> = [];
    while (!lexer.tryConsume('}')) {
      const name = lexer.readName();
      lexer.expect(':');
      fields.push({ name, value: parseValue(lexer) });
    }
    return { kind: 'object', fields };
  }
  if (ch === '$') {
    lexer.expect('$');
    return { kind: 'var', name: lexer.readName() };
  }
  if (ch === '-' || /[0-9]/.test(ch)) return lexer.readNumber();
  const word = lexer.readName();
  if (word === 'true') return { kind: 'boolean', value: true };
  if (word === 'false') return { kind: 'boolean', value: false };
  if (word === 'null') return { kind: 'null' };
  return { kind: 'enum', value: word };
}

function parseDirectives(lexer: Lexer): void {
  while (lexer.peek() === '@') {
    lexer.expect('@');
    lexer.readName();
    if (lexer.peek() === '(') {
      lexer.expect('(');
      while (!lexer.tryConsume(')')) {
        lexer.readName();
        lexer.expect(':');
        parseValue(lexer);
      }
    }
  }
}

function parseSelectionSet(lexer: Lexer): Selection[] {
  lexer.expect('{');
  const out: Selection[] = [];
  while (!lexer.tryConsume('}')) {
    if (lexer.peek() === '.') {
      lexer.expect('.');
      lexer.expect('.');
      lexer.expect('.');
      if (lexer.tryConsumeWord('on')) {
        const typeCondition = lexer.readName();
        parseDirectives(lexer);
        out.push({ kind: 'inline', typeCondition, selections: parseSelectionSet(lexer) });
      } else {
        const name = lexer.readName();
        parseDirectives(lexer);
        out.push({ kind: 'spread', name });
      }
      continue;
    }
    const first = lexer.readName();
    let alias: string | undefined;
    let name = first;
    if (lexer.tryConsume(':')) {
      alias = first;
      name = lexer.readName();
    }
    const args: Record<string, ValueNode> = {};
    if (lexer.peek() === '(') {
      lexer.expect('(');
      while (!lexer.tryConsume(')')) {
        const argName = lexer.readName();
        lexer.expect(':');
        args[argName] = parseValue(lexer);
      }
    }
    parseDirectives(lexer);
    const selections = lexer.peek() === '{' ? parseSelectionSet(lexer) : [];
    out.push({ kind: 'field', alias, name, args, selections });
  }
  return out;
}

function parseType(lexer: Lexer): string {
  let type = '';
  if (lexer.peek() === '[') {
    lexer.expect('[');
    type = `[${parseType(lexer)}]`;
  } else {
    type = lexer.readName();
  }
  while (lexer.tryConsume('!')) type += '!';
  return type;
}

function parseDocument(source: string): Document {
  const lexer = new Lexer(source);
  const operations: Operation[] = [];
  const fragments = new Map<string, FragmentDef>();
  while (!lexer.atEnd()) {
    if (lexer.tryConsumeWord('fragment')) {
      const name = lexer.readName();
      lexer.tryConsumeWord('on');
      const typeCondition = lexer.readName();
      parseDirectives(lexer);
      fragments.set(name, { name, typeCondition, selections: parseSelectionSet(lexer) });
      continue;
    }
    let kind: 'query' | 'mutation' = 'query';
    if (lexer.tryConsumeWord('query')) kind = 'query';
    else if (lexer.tryConsumeWord('mutation')) kind = 'mutation';
    else if (lexer.tryConsumeWord('subscription')) kind = 'query';
    let name: string | undefined;
    if (/[A-Za-z_]/.test(lexer.peek())) name = lexer.readName();
    const varDefs: VarDef[] = [];
    if (lexer.peek() === '(') {
      lexer.expect('(');
      while (!lexer.tryConsume(')')) {
        lexer.expect('$');
        const varName = lexer.readName();
        lexer.expect(':');
        parseType(lexer);
        let defaultValue: ValueNode | undefined;
        if (lexer.tryConsume('=')) defaultValue = parseValue(lexer);
        varDefs.push({ name: varName, defaultValue });
      }
    }
    parseDirectives(lexer);
    operations.push({ kind, name, varDefs, selections: parseSelectionSet(lexer) });
  }
  return { operations, fragments };
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'var': {
      if (node.name in variables) return variables[node.name];
      return undefined;
    }
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

/** A resolved object value, tagged with its GraphQL type name. */
class G {
  readonly type: string;
  readonly value: unknown;
  constructor(type: string, value: unknown) {
    this.type = type;
    this.value = value;
  }
}

interface Ctx {
  forge: Forge;
  origin: string;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description',
    'isPrivate', 'createdAt', 'updatedAt',
  ],
  User: ['login', 'name', 'id', 'email', 'url'],
  Ref: ['name', 'target'],
  Commit: ['oid', 'message'],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author',
    'labels', 'comments', 'repository', 'closedAt',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueCommentConnection: ['nodes', 'pageInfo'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state',
    'merged', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'mergedAt', 'mergeCommit',
    'headRef', 'baseRef',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  ReopenIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  SearchResultItemConnection: ['nodes', 'pageInfo'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

const TYPE_KINDS: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  Repository: 'OBJECT',
  User: 'OBJECT',
  Ref: 'OBJECT',
  Commit: 'OBJECT',
  Issue: 'OBJECT',
  IssueConnection: 'OBJECT',
  IssueEdge: 'OBJECT',
  IssueComment: 'OBJECT',
  IssueCommentConnection: 'OBJECT',
  PullRequest: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestEdge: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PageInfo: 'OBJECT',
  CommentEdge: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  ReopenIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  SearchResultItemConnection: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
};

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

function repoG(repo: Repo): G {
  return new G('Repository', repo);
}

function itemG(item: Item): G {
  return new G(item.kind === 'pr' ? 'PullRequest' : 'Issue', item);
}

function issueState(item: Item): string {
  return item.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(item: Item): string {
  if (item.merged === true) return 'MERGED';
  return item.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoOf(ctx: Ctx, owner: unknown, name: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  return ctx.forge.getRepo(owner, name) ?? null;
}

function issueByGlobal(ctx: Ctx, id: unknown): { repo: Repo; item: Item } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || (decoded.kind !== 'Issue' && decoded.kind !== 'PullRequest')) return null;
  const [owner, name, number] = decoded.parts;
  if (owner === undefined || name === undefined || number === undefined) return null;
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === undefined) return null;
  const item = repo.items.get(Number(number));
  if (item === undefined) return null;
  return { repo, item };
}

function repoByGlobal(ctx: Ctx, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const [owner, name] = decoded.parts;
  if (owner === undefined || name === undefined) return null;
  return ctx.forge.getRepo(owner, name) ?? null;
}

interface PageArgs {
  first?: number;
  after?: string | null;
}

function paginateConnection<T>(items: readonly T[], args: PageArgs): { nodes: T[]; hasNextPage: boolean; endCursor: string | null } {
  const start = args.after === undefined || args.after === null ? 0 : indexOfCursor(args.after) + 1;
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : items.length;
  const slice = items.slice(start, start + first);
  const end = start + slice.length;
  return {
    nodes: [...slice],
    hasNextPage: end < items.length,
    endCursor: slice.length === 0 ? null : cursorOf(end - 1),
  };
}

function resolveArgs(field: FieldSelection, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(field.args)) {
    const value = resolveValue(node, ctx.variables);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function fieldError(ctx: Ctx, parentType: string, name: string, path: Array<string | number>): void {
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".`, path });
}

/** Resolve one field of an object value. Returns a G, a scalar, an array, or null. */
function resolveField(ctx: Ctx, parentType: string, parent: unknown, field: FieldSelection, path: Array<string | number>): unknown {
  const args = resolveArgs(field, ctx);
  const name = field.name;

  if (name === '__typename') return parentType;

  if (parentType === 'Query') {
    if (name === 'viewer') return new G('User', VIEWER);
    if (name === 'repository') {
      const repo = repoOf(ctx, args.owner, args.name);
      return repo === null ? null : repoG(repo);
    }
    if (name === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoByGlobal(ctx, id);
        return repo === null ? null : repoG(repo);
      }
      const found = issueByGlobal(ctx, id);
      if (found === null) return null;
      return itemG(found.item);
    }
    if (name === 'search') {
      const type = args.type;
      const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
      const found: G[] = [];
      if (type === 'ISSUE') {
        for (const repo of ctx.forge.listRepos()) {
          for (const item of repo.items.values()) {
            if (item.kind !== 'issue') continue;
            if (query !== '' && !item.title.toLowerCase().includes(query)) continue;
            found.push(itemG(item));
          }
        }
      }
      return new G('SearchResultItemConnection', { nodes: found });
    }
    if (name === '__type') {
      const typeName = args.name;
      if (typeof typeName !== 'string') return null;
      const kind = TYPE_KINDS[typeName];
      if (kind === undefined) return null;
      return new G('__Type', { name: typeName, kind });
    }
    if (name === '__schema') {
      return new G('__Schema', {});
    }
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === '__Type') {
    const typeName = (parent as { name: string }).name;
    if (name === 'kind') return TYPE_KINDS[typeName] ?? null;
    if (name === 'name') return typeName;
    if (name === 'fields') {
      const fields = TYPE_FIELDS[typeName];
      if (fields === undefined) return null;
      return fields.map((fieldName) => new G('__Field', { name: fieldName }));
    }
    if (name === 'enumValues') {
      const values = TYPE_ENUMS[typeName];
      if (values === undefined) return null;
      return values.map((value) => new G('__EnumValue', { name: value }));
    }
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === '__Schema') {
    if (name === 'queryType') return new G('__Type', { name: 'Query', kind: 'OBJECT' });
    if (name === 'mutationType') return new G('__Type', { name: 'Mutation', kind: 'OBJECT' });
    if (name === 'types') {
      return Object.keys(TYPE_KINDS).map((typeName) => new G('__Type', { name: typeName, kind: TYPE_KINDS[typeName] }));
    }
    if (name === 'directives') return [];
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === '__Field' || parentType === '__EnumValue') {
    if (name === 'name') return (parent as { name: string }).name;
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const repo = repoByGlobal(ctx, input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'Repository not found.', path });
        return new G('CreateIssuePayload', { issue: null });
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const item = ctx.forge.newItem(repo, 'issue', { title, body: typeof input.body === 'string' ? input.body : '' });
      return new G('CreateIssuePayload', { issue: itemG(item) });
    }
    if (name === 'closeIssue' || name === 'reopenIssue') {
      const found = issueByGlobal(ctx, input.issueId);
      if (found === null) {
        ctx.errors.push({ message: 'Issue not found.', path });
        return new G(name === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload', { issue: null });
      }
      found.item.state = name === 'closeIssue' ? 'closed' : 'open';
      found.item.updatedAt = ctx.forge.stamp();
      return new G(name === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload', { issue: itemG(found.item) });
    }
    if (name === 'createPullRequest') {
      const repo = repoByGlobal(ctx, input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'Repository not found.', path });
        return new G('CreatePullRequestPayload', { pullRequest: null });
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) {
        ctx.errors.push({ message: 'Head or base branch does not exist.', path });
        return new G('CreatePullRequestPayload', { pullRequest: null });
      }
      if (headTip === baseTip || ctx.forge.isAncestor(repo, headTip, baseTip)) {
        ctx.errors.push({ message: 'No commits between base and head.', path });
        return new G('CreatePullRequestPayload', { pullRequest: null });
      }
      for (const existing of repo.items.values()) {
        if (existing.kind === 'pr' && existing.state === 'open' && existing.head?.ref === head && existing.base?.ref === base) {
          ctx.errors.push({ message: 'A pull request already exists for this head and base.', path });
          return new G('CreatePullRequestPayload', { pullRequest: null });
        }
      }
      const item = ctx.forge.newItem(repo, 'pr', {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: { ref: head, sha: headTip },
        base: { ref: base, sha: baseTip },
      });
      return new G('CreatePullRequestPayload', { pullRequest: itemG(item) });
    }
    if (name === 'mergePullRequest') {
      const found = issueByGlobal(ctx, input.pullRequestId);
      if (found === null || found.item.kind !== 'pr') {
        ctx.errors.push({ message: 'Pull request not found.', path });
        return new G('MergePullRequestPayload', { pullRequest: null });
      }
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      const method = methodRaw === 'MERGE' ? 'merge' : methodRaw === 'REBASE' ? 'rebase' : 'squash';
      const result = ctx.forge.mergePr(found.repo, found.item, method);
      if ('error' in result) {
        ctx.errors.push({ message: result.error === 'merge conflict' ? 'Merge conflict.' : result.error, path });
        return new G('MergePullRequestPayload', { pullRequest: itemG(found.item) });
      }
      return new G('MergePullRequestPayload', { pullRequest: itemG(found.item) });
    }
    if (name === 'addComment') {
      const found = issueByGlobal(ctx, input.subjectId);
      if (found === null) {
        ctx.errors.push({ message: 'Subject not found.', path });
        return new G('AddCommentPayload', { commentEdge: null });
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const now = ctx.forge.stamp();
      const comment = { id: ctx.forge.nextId(), body, createdAt: now, updatedAt: now };
      found.item.comments.push(comment);
      found.item.updatedAt = ctx.forge.stamp();
      const node = new G('IssueComment', { repo: found.repo, item: found.item, comment });
      return new G('AddCommentPayload', { commentEdge: new G('CommentEdge', { node }) });
    }
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'User') {
    const user = parent as typeof VIEWER;
    if (name === 'login') return user.login;
    if (name === 'name') return user.name;
    if (name === 'id') return globalId('User', user.login);
    if (name === 'email') return user.email;
    if (name === 'url') return `${ctx.origin}/${user.login}`;
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'Repository') {
    const repo = parent as Repo;
    switch (name) {
      case 'id': return globalId('Repository', repo.owner, repo.name);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return new G('User', VIEWER);
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return new G('Ref', { name: repo.defaultBranch, tip });
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'url': return `${ctx.origin}/${repo.owner}/${repo.name}`;
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'issue': {
        const item = repo.items.get(typeof args.number === 'number' ? args.number : -1);
        if (item === undefined || item.kind !== 'issue') return null;
        return itemG(item);
      }
      case 'issues': {
        let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
        if (Array.isArray(args.states)) {
          const wanted = new Set((args.states as unknown[]).map((state) => String(state)));
          items = items.filter((item) => wanted.has(issueState(item)));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = orderBy.direction === 'ASC' ? 1 : -1;
        const fieldKey = orderBy.field === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
        items.sort((a, b) => {
          const cmp = a[fieldKey] < b[fieldKey] ? -1 : a[fieldKey] > b[fieldKey] ? 1 : a.number - b.number;
          return cmp * direction;
        });
        const page = paginateConnection(items, { first: args.first as number | undefined, after: args.after as string | null | undefined });
        return new G('IssueConnection', { nodes: page.nodes.map(itemG), pageInfo: page });
      }
      case 'pullRequests': {
        const items = [...repo.items.values()].filter((item) => item.kind === 'pr');
        items.sort((a, b) => a.number - b.number);
        const page = paginateConnection(items, { first: args.first as number | undefined, after: args.after as string | null | undefined });
        return new G('PullRequestConnection', { nodes: page.nodes.map(itemG), pageInfo: page });
      }
      case 'pullRequest': {
        const item = repo.items.get(typeof args.number === 'number' ? args.number : -1);
        if (item === undefined || item.kind !== 'pr') return null;
        return itemG(item);
      }
      default:
        fieldError(ctx, parentType, name, path);
        return null;
    }
  }

  if (parentType === 'Ref') {
    const ref = parent as { name: string; tip: string };
    if (name === 'name') return ref.name;
    if (name === 'target') return new G('Commit', { oid: ref.tip });
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'Commit') {
    const commit = parent as { oid: string };
    if (name === 'oid') return commit.oid;
    if (name === 'message') return '';
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'Issue' || parentType === 'PullRequest') {
    const holder = parent as Item;
    const repo = repoForItem(ctx, holder);
    switch (name) {
      case 'id':
        return globalId(holder.kind === 'pr' ? 'PullRequest' : 'Issue', repo?.owner ?? '', repo?.name ?? '', holder.number);
      case 'number': return holder.number;
      case 'title': return holder.title;
      case 'body': return holder.body;
      case 'state': return parentType === 'Issue' ? issueState(holder) : prState(holder);
      case 'url': return `${ctx.origin}/${repo?.owner ?? ''}/${repo?.name ?? ''}/${holder.kind === 'pr' ? 'pull' : 'issues'}/${holder.number}`;
      case 'createdAt': return holder.createdAt;
      case 'updatedAt': return holder.updatedAt;
      case 'author': return new G('User', VIEWER);
      case 'comments': {
        const nodes = holder.comments.map((comment) => new G('IssueComment', { repo: repo!, item: holder, comment }));
        return new G('IssueCommentConnection', { nodes });
      }
      default:
        break;
    }
    if (parentType === 'PullRequest') {
      switch (name) {
        case 'headRefName': return holder.head?.ref ?? null;
        case 'baseRefName': return holder.base?.ref ?? null;
        case 'merged': return holder.merged ?? false;
        case 'mergedAt': return holder.mergedAt ?? null;
        case 'mergeable': {
          if (repo === undefined) return 'UNKNOWN';
          return ctx.forge.prMergeable(repo, holder) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'files': {
          if (repo === undefined) return new G('PullRequestChangedFileConnection', { nodes: [] });
          const baseTip = repo.refs.get(`refs/heads/${holder.base!.ref}`);
          const mergeBase = baseTip === undefined ? null : ctx.forge.mergeBase(repo, holder.head!.sha, baseTip);
          const files = ctx.forge.diffFiles(ctx.forge.flatAt(repo, mergeBase), ctx.forge.flatAt(repo, holder.head!.sha), repo);
          const nodes = files.map((file) => new G('PullRequestChangedFile', {
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
          }));
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : nodes.length;
          return new G('PullRequestChangedFileConnection', { nodes: nodes.slice(0, first) });
        }
        default:
          fieldError(ctx, parentType, name, path);
          return null;
      }
    }
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'PullRequestChangedFileConnection' || parentType === 'IssueCommentConnection' || parentType === 'SearchResultItemConnection') {
    const conn = parent as { nodes: unknown[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
    if (name === 'nodes') return conn.nodes;
    if (name === 'edges') {
      return conn.nodes.map((node, index) => new G(parentType === 'IssueConnection' ? 'IssueEdge' : parentType === 'PullRequestConnection' ? 'PullRequestEdge' : 'CommentEdge', { node, cursor: cursorOf(index) }));
    }
    if (name === 'pageInfo') {
      const info = conn.pageInfo ?? { hasNextPage: false, endCursor: null };
      return new G('PageInfo', info);
    }
    if (name === 'totalCount') return conn.nodes.length;
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'IssueEdge' || parentType === 'PullRequestEdge' || parentType === 'CommentEdge') {
    const edge = parent as { node: unknown; cursor: string };
    if (name === 'node') return edge.node;
    if (name === 'cursor') return edge.cursor;
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'PageInfo') {
    const info = parent as { hasNextPage: boolean; endCursor: string | null };
    if (name === 'hasNextPage') return info.hasNextPage;
    if (name === 'hasPreviousPage') return false;
    if (name === 'startCursor') return null;
    if (name === 'endCursor') return info.endCursor;
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'PullRequestChangedFile') {
    const file = parent as { path: string; additions: number; deletions: number; changeType: string };
    if (name === 'path') return file.path;
    if (name === 'additions') return file.additions;
    if (name === 'deletions') return file.deletions;
    if (name === 'changeType') return file.changeType;
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'IssueComment') {
    const holder = parent as { repo: Repo; item: Item; comment: { id: number; body: string; createdAt: string; updatedAt: string } };
    if (name === 'id') return globalId('IssueComment', holder.repo.owner, holder.repo.name, holder.item.number, holder.comment.id);
    if (name === 'body') return holder.comment.body;
    if (name === 'createdAt') return holder.comment.createdAt;
    if (name === 'updatedAt') return holder.comment.updatedAt;
    if (name === 'author') return new G('User', VIEWER);
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (
    parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload' || parentType === 'ReopenIssuePayload'
  ) {
    const payload = parent as { issue: G | null };
    if (name === 'issue') return payload.issue;
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
    const payload = parent as { pullRequest: G | null };
    if (name === 'pullRequest') return payload.pullRequest;
    fieldError(ctx, parentType, name, path);
    return null;
  }

  if (parentType === 'AddCommentPayload') {
    const payload = parent as { commentEdge: G | null };
    if (name === 'commentEdge') return payload.commentEdge;
    fieldError(ctx, parentType, name, path);
    return null;
  }

  fieldError(ctx, parentType, name, path);
  return null;
}

const ITEM_REPO = new WeakMap<Item, Repo>();

function repoForItem(ctx: Ctx, item: Item): Repo | undefined {
  const cached = ITEM_REPO.get(item);
  if (cached !== undefined) return cached;
  for (const repo of ctx.forge.listRepos()) {
    if (repo.items.get(item.number) === item) {
      ITEM_REPO.set(item, repo);
      return repo;
    }
  }
  return undefined;
}

/** Execute a selection set against a parent value of a known type. */
function executeSelections(ctx: Ctx, parentType: string, parent: unknown, selections: Selection[], path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(ctx, parentType, parent, fragment.selections, path));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(ctx, parentType, parent, selection.selections, path));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    const value = resolveField(ctx, parentType, parent, selection, fieldPath);
    out[key] = completeValue(ctx, value, selection.selections, fieldPath);
  }
  return out;
}

/** Shape a resolved value against the field's sub-selections. */
function completeValue(ctx: Ctx, value: unknown, selections: Selection[], path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry, index) => completeValue(ctx, entry, selections, [...path, index]));
  }
  if (value instanceof G) {
    if (selections.length === 0) return value.value;
    return executeSelections(ctx, value.type, value.value, selections, path);
  }
  return value;
}

/** Run one operation document. Returns the {data, errors?} body. */
export function executeGraphQL(forge: Forge, origin: string, query: string, variables: Record<string, unknown>, operationName?: string): Record<string, unknown> {
  let doc: Document;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  let operation = doc.operations[0];
  if (operationName !== undefined) {
    operation = doc.operations.find((candidate) => candidate.name === operationName) ?? operation;
  }
  if (operation === undefined) {
    return { errors: [{ message: 'No operation in the document.' }] };
  }
  const vars: Record<string, unknown> = { ...variables };
  for (const varDef of operation.varDefs) {
    if (!(varDef.name in vars) && varDef.defaultValue !== undefined) {
      vars[varDef.name] = resolveValue(varDef.defaultValue, vars);
    }
  }
  const ctx: Ctx = { forge, origin, variables: vars, fragments: doc.fragments, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, null, operation.selections, []);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return body;
}

/** The HTTP handler for POST /api/graphql (single operation or a JSON batch array). */
export function handleGraphQL(forge: Forge, origin: string, bodyText: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body is not valid JSON.' }] } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'Operation must be an object.' }] };
      const record = entry as Record<string, unknown>;
      return executeGraphQL(
        forge,
        origin,
        typeof record.query === 'string' ? record.query : '',
        (record.variables as Record<string, unknown> | undefined) ?? {},
        typeof record.operationName === 'string' ? record.operationName : undefined,
      );
    });
    return { status: 200, body: results };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { errors: [{ message: 'Request body must be a JSON object.' }] } };
  }
  const record = parsed as Record<string, unknown>;
  return {
    status: 200,
    body: executeGraphQL(
      forge,
      origin,
      typeof record.query === 'string' ? record.query : '',
      (record.variables as Record<string, unknown> | undefined) ?? {},
      typeof record.operationName === 'string' ? record.operationName : undefined,
    ),
  };
}
