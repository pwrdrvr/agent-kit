import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Create a throwaway temp dir under the OS tmp dir. */
export function makeTempDir(prefix = "codex-discovery-test-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export type FakeCodexOptions = {
  /** Directory to drop the shim into. */
  dir: string;
  /** Filename for the shim. Defaults to `codex`. */
  name?: string;
  /** Reported `codex --version` output. */
  version?: string;
  /** Override the entire shell script body (advanced). */
  body?: string;
};

/**
 * Write an executable POSIX `codex` shim that responds to `--version`,
 * `login status`, and `login`. Returns the absolute path to the shim.
 *
 * `login status` exit code is controlled by the `CODEX_TEST_LOGGED_IN` env
 * the parent passes through (it inherits process.env on spawn) OR by a marker
 * file named `logged-in` in the CODEX_HOME the parent passes via env.
 */
export function writeFakeCodex(options: FakeCodexOptions): string {
  const name = options.name ?? "codex";
  const version = options.version ?? "0.130.0";
  const shimPath = path.join(options.dir, name);
  const body =
    options.body ??
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli ${version}"
  exit 0
fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  if [ -f "$CODEX_HOME/logged-in" ]; then
    echo "Logged in as test@example.com"
    exit 0
  fi
  echo "Not logged in"
  exit 1
fi
if [ "$1" = "login" ]; then
  echo "To sign in, open: https://auth.openai.com/oauth/authorize?client_id=abc&code=xyz"
  exit 0
fi
exit 0
`;
  writeFileSync(shimPath, body, "utf8");
  chmodSync(shimPath, 0o755);
  return shimPath;
}

/** Build a base64url-encoded JWT (header.payload.signature) from a claims object. */
export function makeFakeJwt(claims: Record<string, unknown>): string {
  const b64url = (value: string): string =>
    Buffer.from(value, "utf8")
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  return `${header}.${payload}.sig`;
}

/** Write an `auth.json` containing `tokens.id_token` into a CODEX_HOME dir. */
export function writeAuthJson(codexHome: string, idToken: string): void {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { id_token: idToken } }),
    "utf8",
  );
}
