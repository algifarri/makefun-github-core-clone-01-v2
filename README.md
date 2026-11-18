# makefun-github-core-clone-01-v2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/algifarri/makefun-github-core-clone-01-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/algifarri/makefun-github-core-clone-01-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process
(Node 22, standard library only, no dependencies, no git binary).

One in-memory store serves four surfaces at once:

- **git smart HTTP** (`/<owner>/<repo>.git`) — protocol v2 and v0
  upload-pack (ls-refs, fetch, shallow/deepen), receive-pack with
  report-status in sideband, packfiles written without deltas and read
  with OFS/REF delta resolution.
- **REST v3** (`/api/v3`) — users, repositories, branches, git refs,
  commits, contents, labels, issues and pull requests with merge.
- **GraphQL v4** (`/api/graphql`) — a hand-written parser and executor
  for viewer/repository/issues/pull-request reads, the create/close/merge
  mutations, Relay node ids, cursor connections and introspection.
- **MCP** (`/mcp`) — JSON-RPC 2.0, `server/discover` for the 2026-07-28
  revision plus the legacy `initialize` handshake, and eight tools.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

With `MAKEFUN_ENV_URL` set, the entry registers its ephemeral port with
the trial environment and exits when the environment reports done. Without
it, the process refuses to start. For local practice, run the server
through a small launcher that binds a fixed port instead (see the kit's
`sdk/run.ts`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=ajkq5baq&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
