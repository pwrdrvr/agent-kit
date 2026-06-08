# agent-kit

A small family of MIT packages for driving a **local agent** (Codex App Server
now; Kimi/Qwen/Gemini/Grok over ACP next) and presenting a **consistent
chat/tool experience** behind one neutral schema. Extracted from PwrSnap and
PwrAgnt so downstream apps consume it instead of re-implementing the transport,
discovery, turn loop, and chat surface.

## Packages

| Package | Role |
|---|---|
| [`@pwrdrvr/agent-core`](packages/agent-core) | Neutral message/thread/tool-call schema + injected interfaces (`Logger`, `ThreadStore`, `Clock`, `OpenExternal`). The dependency hub. Zero runtime deps. |
| `@pwrdrvr/agent-transport` | JSON-RPC 2.0 core + stdio transport. *(planned)* |
| `@pwrdrvr/codex-discovery` | Codex binary discovery, version compare, auth profiles, login/relogin. *(planned)* |
| `@pwrdrvr/agent-client` | Codex App Server adapter: thread client + chat controller + `defineTool`, normalizing into `agent-core`. *(planned)* |
| `@pwrdrvr/agent-acp` | ACP adapter for Kimi/Qwen/Gemini/Grok, normalizing into `agent-core`. *(planned)* |
| `@pwrdrvr/agent-chat-react` | Presentational chat UI (React peer dep). *(planned)* |

The Codex protocol types live in a separate repo,
[`@pwrdrvr/codex-app-server-protocol`](https://github.com/pwrdrvr/codex-app-server-protocol),
consumed as a normal versioned dependency.

The design and sequencing live in
[docs/plans](docs/plans/2026-06-02-001-feat-agent-kit-monorepo-buildout-plan.md).

## Develop

```bash
nvm use            # v24.14.1
pnpm install
pnpm build         # tsup per package
pnpm typecheck
pnpm test          # vitest
pnpm lint:licenses # MIT-only gate
pnpm lint:deps     # single-version guard (zod)
```

## zod: keep it to one copy

`@pwrdrvr/agent-acp` speaks ACP through
[`@zed-industries/agent-client-protocol`](https://www.npmjs.com/package/@zed-industries/agent-client-protocol),
which still pins **`zod@^3`** (latest `0.4.5`). First-party packages here
(`@pwrdrvr/agent-client`, and consumers like PwrAgent / PwrSnap) use **`zod@^4`**.
Left alone, an app that depends on both ends up with **two copies of zod** —
wasted bundle, and the classic cross-instance footgun where a schema built by
one copy fails `instanceof` against the other.

agent-acp imports nothing from zod directly — its only zod is the zed lib's
internal validation — and the zed lib runs **clean under zod 4** (its schemas are
exercised by agent-acp's `acp-connection` tests). So we collapse to a single zod
with one root override:

```jsonc
// package.json
"pnpm": { "overrides": { "zod": "^4.0.0" } }
```

This repo ships that override and a CI guard (`pnpm lint:deps`,
[scripts/check-single-version-deps.mjs](scripts/check-single-version-deps.mjs))
that fails if a second zod ever creeps back in. **Consumers should add the same
override to their own root `package.json`** — a dependency's overrides don't
propagate, so the dedupe has to be declared where the install root is. Drop the
override once the zed lib ships zod 4 natively.

## Release

Versioning is per-package via [changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset            # record a bump
```

On merge to `main`, the Release workflow opens a "Version Packages" PR; merging
that publishes the changed packages to npm via **OIDC trusted publishing**
(tokenless, with provenance, gated behind the `npm-publish` environment). Each
package needs a one-time bootstrap publish + trusted-publisher config the first
time — same flow as the protocol repo.

## License

MIT © PwrDrvr LLC.
