---
"@pwrdrvr/agent-acp": patch
---

ACP: send `session/set_config_option` without the `_` extension prefix

The generic transport routes config-option requests through the ACP library's
`extMethod`, which prefixes every extension method with `_`
(`_session/set_config_option`). Agents that implement config options (e.g. Kimi)
expose them WITHOUT the underscore and reject the prefixed name with "Method not
found" — so the thought-level / thinking toggle (and any other config option)
silently never applied. The outbound ndjson stream now rewrites
`_session/set_config_option` → `session/set_config_option`; responses correlate
by JSON-RPC `id`, so the rewrite is transparent to the library. New exported
helper `rewriteOutboundAcpLine`.
