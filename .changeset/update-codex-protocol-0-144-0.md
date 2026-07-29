---
"@pwrdrvr/agent-client": patch
---

Update `@pwrdrvr/codex-app-server-protocol` to 0.144.0 and emit its new
discriminated dynamic-tool wire format. Add `toDynamicToolFunctionSpec` for flat
function consumers, support unnamespaced and deferred tools, and make
`buildToolCatalog` group namespaced tools into namespace objects.
