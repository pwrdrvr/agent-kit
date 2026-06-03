import { describe, it, expect } from "vitest";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  discoverCodexAuthProfiles,
  resolveDefaultCodexHome,
  resolveCodexHomeForProfile,
  readCodexAuthInfo,
} from "../src/index";
import { makeTempDir, makeFakeJwt, writeAuthJson } from "./helpers";

describe("resolveDefaultCodexHome / resolveCodexHomeForProfile", () => {
  it("honors CODEX_HOME env over homeDir", () => {
    const home = makeTempDir();
    const codexHome = makeTempDir();
    try {
      expect(
        resolveDefaultCodexHome({ env: { CODEX_HOME: codexHome }, homeDir: home }),
      ).toBe(path.resolve(codexHome));
      expect(resolveDefaultCodexHome({ env: {}, homeDir: home })).toBe(
        path.join(home, ".codex"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("maps a named profile to profiles/<name> and rejects empty", () => {
    const home = makeTempDir();
    try {
      expect(resolveCodexHomeForProfile("work", { env: {}, homeDir: home })).toBe(
        path.join(home, ".codex", "profiles", "work"),
      );
      expect(resolveCodexHomeForProfile("", { env: {}, homeDir: home })).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("discoverCodexAuthProfiles", () => {
  it("enumerates the default profile (name \"\") plus named subdirs with hasAuthFile correct", () => {
    const home = makeTempDir();
    try {
      const codexRoot = path.join(home, ".codex");
      // Default home has an auth.json.
      writeAuthJson(codexRoot, makeFakeJwt({ email: "default@example.com" }));
      // Named profile dirs.
      const profilesRoot = path.join(codexRoot, "profiles");
      mkdirSync(path.join(profilesRoot, "work"), { recursive: true });
      writeAuthJson(
        path.join(profilesRoot, "work"),
        makeFakeJwt({ email: "work@example.com" }),
      );
      mkdirSync(path.join(profilesRoot, "personal"), { recursive: true });
      // personal has no auth.json.

      const snapshot = discoverCodexAuthProfiles({ env: {}, homeDir: home });

      const def = snapshot.profiles.find((p) => p.name === "");
      expect(def).toBeDefined();
      expect(def?.source).toBe("default");
      expect(def?.displayName).toBe("System default");
      expect(def?.hasAuthFile).toBe(true);
      expect(def?.accountEmail).toBe("default@example.com");

      const work = snapshot.profiles.find((p) => p.name === "work");
      expect(work?.hasAuthFile).toBe(true);
      expect(work?.accountEmail).toBe("work@example.com");
      expect(work?.exists).toBe(true);

      const personal = snapshot.profiles.find((p) => p.name === "personal");
      expect(personal?.hasAuthFile).toBe(false);
      expect(personal?.accountEmail).toBeUndefined();

      expect(snapshot.profileRoot).toBe(profilesRoot);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("selects the configured profile and reports effectiveCodexHome", () => {
    const home = makeTempDir();
    try {
      const profilesRoot = path.join(home, ".codex", "profiles");
      mkdirSync(path.join(profilesRoot, "work"), { recursive: true });
      const snapshot = discoverCodexAuthProfiles({
        env: {},
        homeDir: home,
        configuredProfile: "work",
      });
      const selected = snapshot.profiles.find((p) => p.selected);
      expect(selected?.name).toBe("work");
      expect(snapshot.effectiveCodexHome).toBe(path.join(profilesRoot, "work"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not error when the profiles root is absent (ENOENT swallowed)", () => {
    const home = makeTempDir();
    try {
      const snapshot = discoverCodexAuthProfiles({ env: {}, homeDir: home });
      expect(snapshot.error).toBeUndefined();
      // Only the default profile shows up.
      expect(snapshot.profiles).toHaveLength(1);
      expect(snapshot.profiles[0]?.name).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("readCodexAuthInfo", () => {
  it("returns {} for a missing auth.json without throwing", () => {
    const home = makeTempDir();
    try {
      expect(readCodexAuthInfo(path.join(home, "nope"))).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns {} for a corrupt / short auth.json without throwing", () => {
    const codexHome = makeTempDir();
    try {
      // Not JSON.
      writeFileSync(path.join(codexHome, "auth.json"), "not json at all", "utf8");
      expect(readCodexAuthInfo(codexHome)).toEqual({});

      // JSON but id_token is a non-JWT short string.
      writeFileSync(
        path.join(codexHome, "auth.json"),
        JSON.stringify({ tokens: { id_token: "abc" } }),
        "utf8",
      );
      expect(readCodexAuthInfo(codexHome)).toEqual({});
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("extracts email + planType from a well-formed JWT", () => {
    const codexHome = makeTempDir();
    try {
      writeAuthJson(
        codexHome,
        makeFakeJwt({
          email: "pilot@example.com",
          "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
        }),
      );
      expect(readCodexAuthInfo(codexHome)).toEqual({
        email: "pilot@example.com",
        planType: "pro",
      });
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("falls back to a root-level chatgpt_plan_type claim", () => {
    const codexHome = makeTempDir();
    try {
      writeAuthJson(
        codexHome,
        makeFakeJwt({ email: "x@example.com", chatgpt_plan_type: "plus" }),
      );
      expect(readCodexAuthInfo(codexHome).planType).toBe("plus");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("ignores an email claim that is not a valid email", () => {
    const codexHome = makeTempDir();
    try {
      writeAuthJson(codexHome, makeFakeJwt({ email: "no-at-sign" }));
      expect(readCodexAuthInfo(codexHome).email).toBeUndefined();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
