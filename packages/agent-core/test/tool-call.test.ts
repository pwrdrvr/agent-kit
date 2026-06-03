import { describe, it, expect } from "vitest";
import {
  inferToolKind,
  isGenericLabel,
  preferSpecificLabel,
  mergeToolCall,
  type NormalizedToolCall
} from "../src/index";

describe("inferToolKind", () => {
  it("classifies read-ish tools", () => {
    expect(inferToolKind("read_file")).toBe("read");
    expect(inferToolKind("inspect_project")).toBe("read");
    expect(inferToolKind("library_get")).toBe("read");
  });

  it("classifies write/mutation tools", () => {
    expect(inferToolKind("add_caption")).toBe("write");
    expect(inferToolKind("draw_arrow")).toBe("write");
    expect(inferToolKind("redact")).toBe("write");
    expect(inferToolKind("apply_patch")).toBe("write");
  });

  it("classifies command and search and fetch tools", () => {
    expect(inferToolKind("shell")).toBe("command");
    expect(inferToolKind("execute_command")).toBe("command");
    expect(inferToolKind("library_search")).toBe("search");
    expect(inferToolKind("web_fetch")).toBe("fetch");
  });

  it("falls back to other for unrecognized names", () => {
    expect(inferToolKind("frobnicate")).toBe("other");
    expect(inferToolKind("")).toBe("other");
  });
});

describe("preferSpecificLabel / isGenericLabel", () => {
  it("treats known generic labels as generic", () => {
    expect(isGenericLabel("execute")).toBe(true);
    expect(isGenericLabel("  Read ")).toBe(true);
    expect(isGenericLabel("Search the library for cats")).toBe(false);
  });

  it("keeps a specific current label over a generic incoming one", () => {
    expect(preferSpecificLabel("Search library for cats", "search")).toBe("Search library for cats");
  });

  it("takes a specific incoming label over anything", () => {
    expect(preferSpecificLabel("search", "Search library for cats")).toBe("Search library for cats");
    expect(preferSpecificLabel("tool", "Redact SSN")).toBe("Redact SSN");
  });

  it("ignores empty incoming labels", () => {
    expect(preferSpecificLabel("Redact SSN", undefined)).toBe("Redact SSN");
    expect(preferSpecificLabel("Redact SSN", "   ")).toBe("Redact SSN");
  });
});

describe("mergeToolCall", () => {
  const base: NormalizedToolCall = {
    id: "call_1",
    name: "library_search",
    kind: "search",
    label: "search",
    status: "in_progress"
  };

  it("preserves id and applies defined update fields (later state wins)", () => {
    const merged = mergeToolCall(base, {
      id: "call_1",
      status: "completed",
      result: { hits: 3 }
    });
    expect(merged.id).toBe("call_1");
    expect(merged.status).toBe("completed");
    expect(merged.result).toEqual({ hits: 3 });
    // untouched fields survive
    expect(merged.name).toBe("library_search");
  });

  it("reconciles labels via preferSpecificLabel and does not clobber with generic", () => {
    const specificFirst = mergeToolCall(
      { ...base, label: "Search library for cats" },
      { id: "call_1", label: "search" }
    );
    expect(specificFirst.label).toBe("Search library for cats");

    const specificLater = mergeToolCall(base, { id: "call_1", label: "Search library for cats" });
    expect(specificLater.label).toBe("Search library for cats");
  });

  it("never erases prior values with undefined update fields", () => {
    const merged = mergeToolCall({ ...base, result: { hits: 1 } }, { id: "call_1", status: "completed" });
    expect(merged.result).toEqual({ hits: 1 });
  });

  it("shallow-merges nested command detail", () => {
    const withCmd: NormalizedToolCall = {
      ...base,
      kind: "command",
      command: { displayCommand: "ls", cwd: "/tmp" }
    };
    const merged = mergeToolCall(withCmd, {
      id: "call_1",
      command: { displayCommand: "ls -la", output: "a\nb", exitCode: 0 }
    });
    expect(merged.command).toEqual({
      displayCommand: "ls -la",
      cwd: "/tmp",
      output: "a\nb",
      exitCode: 0
    });
  });
});
