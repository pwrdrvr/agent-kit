import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/acp-client";

describe("errorMessage", () => {
  it("uses an Error's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("extracts message (+ code) from a JSON-RPC error OBJECT, not '[object Object]'", () => {
    // The real Grok set_model rejection: a plain object, which String() turns
    // into the useless "[object Object]".
    expect(errorMessage({ code: -32602, message: "model not available in this session" })).toBe(
      "model not available in this session (-32602)"
    );
    expect(errorMessage({ message: "nope" })).toBe("nope");
  });

  it("JSON-dumps an object with no message field", () => {
    expect(errorMessage({ code: -32601 })).toBe('{"code":-32601}');
  });

  it("falls back to a default for empty / unserializable values", () => {
    expect(errorMessage(undefined)).toBe("Turn failed.");
    expect(errorMessage({})).toBe("Turn failed.");
  });

  it("never returns '[object Object]'", () => {
    expect(errorMessage({ code: 1, message: "x" })).not.toContain("[object Object]");
    expect(errorMessage({ data: { nested: true } })).not.toContain("[object Object]");
  });
});
