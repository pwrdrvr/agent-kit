// A per-thread Codex config overlay that disables Codex's coding-agent prompt
// and hosted-tool scaffolding, so an App Server thread is scoped to the host's
// own surfaces (chat, enrichment) instead of inheriting the full coding agent.
//
// Pass this as `config` at `thread/start` (the `-c key=value` mechanism). Empty
// `environments: []` is still required separately at thread/start to drop the
// env-gated shell / unified_exec / apply_patch builtins.

/**
 * Generic "disable coding-agent scaffolding" config overlay. Hosts spread this
 * into `CodexStartThreadOptions.config` (optionally merging their own keys).
 */
export const DISABLE_CODING_AGENT_THREAD_CONFIG: Record<string, unknown> = {
  web_search: "disabled",
  include_permissions_instructions: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_environment_context: false,
  skills: {
    include_instructions: false
  },
  features: {
    apps: false,
    plugins: false,
    tool_suggest: false,
    image_generation: false,
    multi_agent: false,
    goals: false
  }
};
