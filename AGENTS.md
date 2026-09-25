# AGENTS.md — subagent-handoff

Local router (`127.0.0.1:8787` + admin GUI on 8788): requests carrying Claude Code's
`x-claude-code-agent-id` header are rewritten and forwarded to a third-party
Anthropic-compatible provider you pay for; everything else passes through to
`api.anthropic.com` on the subscription.

## Hard constraints

- **HTTPS proxy mode (`config.httpsProxy`, `src/connect.mjs`) is opt-in, and off
  must mean the router behaves as if the feature did not exist**: no `CONNECT`
  listener, no CA files unless it was turned on before, no guard exemption, and
  the original setup steps on the Connect tab (only the mode panel below them is
  new). It switches at runtime on save (`createHttpsProxy().apply`), and turning
  it off also drops open tunnels. `test/connect.test.mjs` pins the listener, CA,
  guard and runtime-toggle parts; keep new proxy-mode behaviour behind the switch.
- **Zero runtime and zero dev dependencies — deliberate, please keep it.** The whole
  point is that a proxy in front of your API traffic has the smallest possible supply
  chain. Tests use built-in `node --test`; syntax gating uses built-in `node --check`.
  Node >= 20, ESM (`"type": "module"`).
- `npm test` is the only gate. `test/syntax.test.mjs` walks `src/` and `test/` and
  runs `node --check` on every file, so new files are gated automatically — do not
  go back to enumerating test files by hand.
- Config lives in `config.json` (gitignored, written 0600). It holds real API keys —
  never commit it, never print it in logs.

## Reading order

1. `README.md` — what it does, the two request kinds, risk disclosure.
2. `src/index.mjs` → `src/proxy.mjs` → `src/routing.mjs` — the request path.
3. `docs/` — routing rules, configuration reference, provider compatibility notes,
   observability, security. These hold the empirical knowledge (request shapes that
   real providers rejected, measurements) that the code cannot tell you.

## Conventions

- Docs and comments: see README's language policy (English and zh-Hant mirrors).
- Commits: Conventional Commits, English.
- **`CHANGELOG.md` is a work log, not a release changelog** (this project has no
  versions). Record behaviour changes, removals, and decisions backed by a
  measurement — in zh-Hant, like `docs/`. Skip pure formatting and renames.
  Write the entry in the same change that makes it, not afterwards.
- **One commit, one change, and the subject must cover everything the diff
  touches.** A commit that also edits something its message does not mention is
  how work becomes invisible; `git log --stat` is the check.
