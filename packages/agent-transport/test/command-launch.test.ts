import { describe, expect, it } from "vitest";
import { createCommandInvocation } from "../src/command-launch";

describe("createCommandInvocation", () => {
  it("keeps native executables on direct argv launches", () => {
    const args = ["--flag", "value & still data"];
    expect(createCommandInvocation({
      command: "C:\\Tools\\agent.exe",
      args,
      env: {},
      platform: "win32"
    })).toEqual({ command: "C:\\Tools\\agent.exe", args });
  });

  it("routes Windows batch shims through the injected ComSpec", () => {
    const invocation = createCommandInvocation({
      command: "C:\\Tools & Shims\\agent.cmd",
      args: ["--flag", "value & echo not-a-command"],
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      platform: "win32"
    });

    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain("Tools^ ^&^ Shims");
    expect(invocation.args[3]).toContain("value^ ^&^ echo^ not-a-command");
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it("rejects command-line breaks instead of interpolating them into cmd.exe", () => {
    expect(() => createCommandInvocation({
      command: "agent.cmd",
      args: ["safe\r\n& echo injected"],
      env: { ComSpec: "cmd.exe" },
      platform: "win32"
    })).toThrow(/cannot be passed safely/);
  });
});
