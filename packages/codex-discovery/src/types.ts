// Result / snapshot shapes for Codex discovery, profiles, and login.
//
// These were originally PwrAgnt's `@pwragent/shared` `Desktop*` contracts; they
// are inlined here so the package depends on no `@pwragent/*` package. Renamed
// without the `Desktop` prefix for the neutral kit.

import type {
  CommandDiscoveryCandidate,
  CommandDiscoverySnapshot
} from "./command-discovery";

/**
 * Where a discovered Codex candidate came from. `env` = the
 * `PWRDRVR_CODEX_COMMAND` override; `config` = a host-persisted command path;
 * `path` = a bare PATH lookup; `application` = a well-known install location.
 */
export type CodexCandidateSource = "env" | "config" | "path" | "application";

export type CodexDiscoveryCandidate = CommandDiscoveryCandidate<CodexCandidateSource>;

export type CodexDiscoverySnapshot = CommandDiscoverySnapshot<CodexCandidateSource>;

/** Where an auth-profile candidate came from on disk. */
export type CodexAuthProfileSource = "default" | "directory" | "config";

export type CodexAuthProfileCandidate = {
  name: string;
  displayName: string;
  codexHome: string;
  accountEmail?: string;
  source: CodexAuthProfileSource;
  exists: boolean;
  selected: boolean;
  hasAuthFile: boolean;
  hasConfigFile: boolean;
};

export type CodexAuthProfileDiscoverySnapshot = {
  profileRoot: string;
  effectiveCodexHome: string;
  profiles: CodexAuthProfileCandidate[];
  error?: string;
};

/** JWT-derived identity surfaced after a profile logs in. */
export type CodexAuthInfo = {
  email?: string;
  planType?: string;
};

export type CodexAuthStatusRequest = {
  profile: string;
};

export type CodexAuthStatusResponse = {
  profile: string;
  codexHome: string;
  authenticated: boolean;
  status: "authenticated" | "unauthenticated" | "failed";
  detail?: string;
  /** ChatGPT account email extracted from the JWT in `auth.json`, when present. */
  email?: string;
  /** ChatGPT plan type ("free", "plus", "pro", "team", "enterprise", …),
   *  best-effort from the JWT's OpenAI-namespaced auth claim. */
  planType?: string;
};

export type CodexProfileLoginResponse = {
  profile: string;
  codexHome: string;
  started: boolean;
  authenticated?: boolean;
  pid?: number;
  loginUrl?: string;
  detail?: string;
};
