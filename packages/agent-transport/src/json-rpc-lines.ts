import type { Readable } from "node:stream";

/** Read LF-delimited protocol frames, accepting CRLF and a final EOF tail.
 * Unlike readline, literal U+2028/U+2029 and bare CR are never delimiters.
 * This only reads the stream; the caller retains process and stderr ownership.
 */
export function readJsonRpcLines(input: Readable, onLine: (line: string) => void): () => void {
  // Node's StringDecoder preserves UTF-8 characters split across byte chunks.
  input.setEncoding("utf8");
  let fragments: string[] = [];
  const emit = (line: string): void => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  const onData = (chunk: string): void => {
    let start = 0;
    let end = chunk.indexOf("\n");
    while (end !== -1) {
      const tail = chunk.slice(start, end);
      if (fragments.length) {
        fragments.push(tail);
        emit(fragments.join(""));
        fragments = [];
      } else {
        emit(tail);
      }
      start = end + 1;
      end = chunk.indexOf("\n", start);
    }
    // Keep fragments rather than repeatedly copying a growing large response.
    if (start < chunk.length) fragments.push(chunk.slice(start));
  };
  const onEnd = (): void => {
    if (fragments.length) emit(fragments.join(""));
    fragments = [];
  };
  input.on("data", onData);
  input.on("end", onEnd);
  // Detach without ending, destroying or otherwise taking ownership of input.
  return () => {
    input.off("data", onData);
    input.off("end", onEnd);
    fragments = [];
  };
}
