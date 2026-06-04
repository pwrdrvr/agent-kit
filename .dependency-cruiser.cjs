// Dependency-cruiser boundaries for the @pwrdrvr/agent-kit monorepo.
//
// Enforces the layered package graph that's otherwise maintained by vigilance:
//
//   agent-core            ← leaf. Imports NOTHING internal. BROWSER-SAFE
//                           (no node: builtins) because agent-chat-react
//                           bundles it into a renderer.
//   agent-transport       → agent-core            (node-only plumbing)
//   codex-discovery       → agent-core            (node-only)
//   agent-acp             → agent-core, agent-transport
//   agent-client          → agent-core, agent-transport, codex-discovery
//   agent-chat-react      → agent-core            (renderer; BROWSER-SAFE)
//
// Rules are matched on package source paths (`packages/<name>/src`). A
// cross-package import resolves through the pnpm workspace symlink, so the
// resolved `to` path still contains `@pwrdrvr/<name>` — that's what the
// layering rules match against.

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular dependency. Break the cycle — extract the shared piece, or invert the dependency.",
      from: {},
      to: { circular: true }
    },

    // ---- agent-core: leaf + browser-safe -------------------------------
    {
      name: "agent-core-is-a-leaf",
      severity: "error",
      comment:
        "agent-core is the schema leaf — it must not import any other @pwrdrvr package.",
      from: { path: "^packages/agent-core/src" },
      to: { path: "@pwrdrvr/(?!agent-core)" }
    },
    {
      name: "agent-core-browser-safe",
      severity: "error",
      comment:
        "agent-core is bundled into a renderer (agent-chat-react depends on it) — it must not import node: builtins. Put node-only code in agent-transport.",
      from: { path: "^packages/agent-core/src" },
      to: { dependencyTypes: ["core"] }
    },

    // ---- agent-chat-react: renderer, browser-safe, agent-core only -----
    {
      name: "agent-chat-react-browser-safe",
      severity: "error",
      comment:
        "agent-chat-react runs in a renderer — it must not import node: builtins.",
      from: { path: "^packages/agent-chat-react/src" },
      to: { dependencyTypes: ["core"] }
    },
    {
      name: "agent-chat-react-imports-core-only",
      severity: "error",
      comment:
        "agent-chat-react may only depend on agent-core (host wires the node-only client at runtime). Importing a node-only kit package would poison the renderer bundle.",
      from: { path: "^packages/agent-chat-react/src" },
      to: { path: "@pwrdrvr/(?!agent-core)" }
    },

    // ---- node-only mid-tier layering -----------------------------------
    {
      name: "agent-transport-imports-core-only",
      severity: "error",
      comment: "agent-transport may only depend on agent-core.",
      from: { path: "^packages/agent-transport/src" },
      to: { path: "@pwrdrvr/(?!agent-core|agent-transport)" }
    },
    {
      name: "codex-discovery-imports-core-only",
      severity: "error",
      comment: "codex-discovery may only depend on agent-core.",
      from: { path: "^packages/codex-discovery/src" },
      to: { path: "@pwrdrvr/(?!agent-core|codex-discovery)" }
    },
    {
      name: "agent-acp-layer",
      severity: "error",
      comment:
        "agent-acp may only depend on agent-core + agent-transport (never agent-client / codex-discovery).",
      from: { path: "^packages/agent-acp/src" },
      to: { path: "@pwrdrvr/(?!agent-core|agent-transport|agent-acp)" }
    },
    {
      name: "agent-client-layer",
      severity: "error",
      comment:
        "agent-client may only depend on agent-core + agent-transport + codex-discovery + codex-app-server-protocol (never agent-acp / agent-chat-react).",
      from: { path: "^packages/agent-client/src" },
      to: {
        path: "@pwrdrvr/(?!agent-core|agent-transport|codex-discovery|agent-client|codex-app-server-protocol)"
      }
    },

    // ---- hygiene -------------------------------------------------------
    {
      name: "no-deep-package-import",
      severity: "error",
      comment:
        "Import a sibling package via its entry point (@pwrdrvr/<name>), never deep into its src/dist.",
      from: { path: "^packages/" },
      to: { path: "@pwrdrvr/[a-z-]+/(src|dist)/" }
    }
  ],
  options: {
    // Only analyze our own source — npm deps are leaves.
    doNotFollow: {
      path: "node_modules"
    },
    tsConfig: {
      fileName: "tsconfig.base.json"
    },
    tsPreCompilationDeps: true,
    exclude: {
      path: "(\\.test\\.ts$|/test/|/dist/|/node_modules/)"
    }
  }
};
