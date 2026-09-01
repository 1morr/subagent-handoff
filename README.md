# subagent-handoff

Keep your Claude Code main conversation on your claude.ai subscription while
routing subagent traffic to a third-party provider you pay for separately.

<p>
  <a href="https://github.com/1morr/subagent-handoff/actions/workflows/test.yml"><img src="https://github.com/1morr/subagent-handoff/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/1morr/subagent-handoff" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933" alt="Node 20+">
</p>

**English** · [繁體中文](README.zh-Hant.md)

> [!WARNING]
> **Read this before using it.**
> - **Unofficial.** Not affiliated with, endorsed by, or sponsored by Anthropic PBC.
>   Anthropic explicitly does not support pointing Claude Code at non-Claude models.
>   If it breaks, you fix it.
> - **Your data goes to the third party in full.** Every routed request carries the
>   whole payload — system prompt, your source code, file contents, tool output.
>   Route subagents somewhere you would be comfortable sending your repository.
> - **Your claude.ai OAuth token passes through this local proxy.** It is forwarded
>   to Anthropic unchanged and is never sent to a third-party provider
>   ([the code that guarantees it](src/proxy.mjs), and the test that pins it).
> - Third-party usage is billed to your own API key. This tool does not modify or
>   spoof any billing identity, and does not bypass anyone's usage limits. Check
>   it against your terms with each provider. Use at your own risk.

The use case: ultracode and Workflow fan out dozens of subagents at once, which
burns through a 5-hour limit fast. Send those to a cheap provider and your main
conversation's reasoning quality is untouched.

![Rack](docs/images/rack.png)

## Why this works

From Claude Code's own [LLM gateway docs](https://code.claude.com/docs/en/llm-gateway):

> **Setting only that variable** (`ANTHROPIC_BASE_URL`)**, without a gateway
> credential, doesn't replace the subscription.** Requests still route through
> the gateway, but a saved claude.ai login remains the active credential, so its
> usage limits and billing apply.

So as long as you do **not** set `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, or
`apiKeyHelper`, Claude Code sends its subscription OAuth token to this router,
and the router decides per request whether it goes to Anthropic (subscription
pays) or to a third party (your API key pays).

The split is made on a header from the
[gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol):

> `x-claude-code-agent-id` — Identifier of the subagent that issued the request,
> **present only on requests from an agent Claude Code spawned inside the session**.

Matching on the header rather than the model name matters because Workflow's
`agent()` only accepts the `sonnet | opus | haiku | fable` aliases — you cannot
name a third-party model inside a workflow script at all.

## Quick start

Node 20+. No npm dependencies.

```bash
git clone https://github.com/1morr/subagent-handoff.git
cd subagent-handoff
npm start
```

The first run creates `config.json`. **Nothing is routed out of the box** — the
default "all subagents" rule ships disabled, because with no provider key yet,
enabling it would just 401 every subagent.

Open <http://127.0.0.1:8788>:

1. **Providers** — enter Base URL, API Key and Model, then run the connectivity test.
2. **Routing** — tick the "all subagents → your provider" rule to enable it.
3. **Connect** — copy the `settings.json` snippet and restart Claude Code.
4. Run `/status` and confirm `Login method` still points at your claude.ai account.
5. Give a subagent some work, then watch the split on the **Rack** tab.

To see the GUI populated without any API key or network access:

```bash
npm run demo      # synthetic traffic against a local fake upstream
```

## The three request kinds

| Condition | How it is detected | Who it is |
|---|---|---|
| `main` | Neither header present | You typing in the prompt box |
| `subagent` | Has `x-claude-code-agent-id` | A first-level agent. **Workflow and ultracode `agent()` calls are all here** |
| `nested` | Also has `x-claude-code-parent-agent-id` | A subagent that spawned another agent |

**To cover ultracode your rule must match `subagent`.** Workflow agents carry no
parent header, so `nested` catches none of them — in a pure ultracode session
`nested` never fires at all.

## Configuration

The GUI is a complete front end for `config.json`; everything is editable there.
Rules are evaluated top to bottom and the first match wins.

| Field | |
|---|---|
| `proxyPort` / `adminPort` | 8787 and 8788. Changing them needs a restart; everything else takes effect per request |
| `passthrough.baseUrl` | Where unmatched requests go. Default `https://api.anthropic.com`, credentials forwarded unchanged |
| `providers[].baseUrl` | Must speak the Anthropic Messages format — the router posts to `{baseUrl}/v1/messages` |
| `providers[].model` | Rewrites `model` before sending. Empty = leave alone |
| `providers[].authStyle` | `bearer` or `x-api-key` |
| `rules[].match` | `any` / `main` / `subagent` / `nested`, optionally narrowed by `modelGlob` or `agentIdGlob` |
| `rules[].providerId` | Which provider, or the reserved value `passthrough` to send it back to the subscription |
| `rules[].modelOverride` | Rewrites `model`, beating `providers[].model`. Works on `passthrough` too |

Full reference including retry policy, traffic logging, and every clamped range:
[docs/configuration.md](docs/configuration.md).

**Two things worth knowing.** When a third-party quota runs dry, switch that
rule's target to `passthrough` rather than disabling it — disabling drops traffic
through to the *next* rule, while pointing at passthrough actually parks it on
the subscription. And `modelOverride` is the only way to give subagents a
different model from the main conversation, since `agent()` inherits the main
model when none is specified and you cannot change that from Claude Code's side.

## Security model

- Both servers bind to `127.0.0.1` only.
- The admin API validates `Origin` and `Host`, so a web page cannot drive it and
  DNS rebinding does not work.
- Stored API keys are never returned to the browser — the GUI receives a masked
  hint and a `__keep__` sentinel.
- `config.json` and `traffic.log` are written `0600`.
- The traffic log records metadata only: no request bodies, no headers, no
  credentials.
- Provider requests are built from an empty header set, so no client credential
  can be forwarded by accident. A test asserts this.

Details and the threat model: [docs/security.md](docs/security.md).

## Development

```bash
npm test     # node --test, no dependencies, no network
```

Zero runtime and dev dependencies is a deliberate constraint — please keep it.
CI runs the suite on Node 20/22/24 across Ubuntu and Windows.

## Documentation

The in-depth docs are written in Traditional Chinese.

| | |
|---|---|
| [docs/configuration.md](docs/configuration.md) | Every config field, default and clamp |
| [docs/routing.md](docs/routing.md) | Rule matching, model overrides, quota switching |
| [docs/observability.md](docs/observability.md) | The traffic log and reading the rack |
| [docs/reliability.md](docs/reliability.md) | Retry, backoff, and why the subscription line does not retry 429 |
| [docs/providers.md](docs/providers.md) | Provider compatibility notes and measurements |
| [docs/security.md](docs/security.md) | Threat model and what is and is not protected |

## License

[MIT](LICENSE)
