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
```

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
