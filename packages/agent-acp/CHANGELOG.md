# @pwrdrvr/agent-acp

## 0.1.3

### Patch Changes

- Multi-instance ACP agent discovery. `discoverLocalAcpAgentInstances` returns
  EVERY installed executable of each agent — every `PATH` match plus the
  strategy's fallback paths plus an optional override that passes the probe —
  each with its parsed version and where it was found (`override` / `path` /
  `fallback`). The default `PATH` scan is injectable (`listExecutables`) and the
  probe env is configurable (`env`), so a host can pass a hydrated `PATH`.
  `discoverLocalAcpAgents` is unchanged in shape (first match per agent), now
  implemented on top of the instance view.
