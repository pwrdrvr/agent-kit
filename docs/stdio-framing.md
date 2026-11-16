# JSON-RPC stdio framing

Protocol stdout is UTF-8 NDJSON: only LF delimits frames. A preceding CR is
removed for CRLF; a final nonempty EOF tail is delivered for compatibility.
Literal U+2028/U+2029 belong to JSON strings. Bare CR is not a delimiter.
Do not use `node:readline` for protocol stdout.

`readJsonRpcLines` uses the stream's UTF-8 decoder and accumulates fragments
without repeatedly copying a growing response. Its returned disposer removes
only its own listeners. Process launch, shutdown, stderr draining and diagnostics
remain the caller's responsibility. `StdioJsonRpcTransport` uses this reader.
Malformed envelopes remain nonfatal in `JsonRpcConnection`, with a warning
containing length and caller context, never the raw message.

## Audit and regression evidence

On Node 24.22.1, the pre-fix `StdioJsonRpcTransport` failed
`test/stdio-framing.property.test.ts` on its first generated case (seed
`-2111893304`, path `0:0:0:0:0`). The shrunk case was one empty arbitrary string
plus the Unicode sentinel, supplied one byte at a time. The exhaustive split
oracle and bare-CR test failed too. The fixed implementation passes.

The oracle compares delivered strings with the original `JSON.stringify`
envelopes. Generation covers arbitrary UTF-16 code units, lone surrogates,
controls, separators, non-BMP UTF-8, varying chunk sizes, LF/CRLF, multiple
frames per chunk and EOF tails. A representative frame is tested at every
two-chunk byte split and one byte at a time. A real subprocess returns a
1,295,500-byte response with both separators while flooding stderr, then
answers another request on the same connection.

The source audit found one production `readline` reader in agent-kit:
`agent-transport/src/stdio-transport.ts`. `agent-client` uses that transport.
`agent-acp/src/acp-connection.ts` uses SDK 1.3.0's `ndJsonStream` instead;
its `LineBuffer` scans byte `0x0a` before decoding complete frames. A real
`AcpConnection` regression covers byte-split Unicode replies. Remaining
agent-kit `readline` references are test servers reading stdin, not stdout
callers. The Unicode echo fixture uses an independent LF parser on stdin.

No Codex storage or live App Server was accessed for these checks.
