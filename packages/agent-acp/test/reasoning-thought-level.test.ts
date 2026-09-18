import { describe, expect, it } from "vitest";
import { reasoningValueForThoughtLevel } from "../src/acp-client";

// Kimi's `thinking` thought_level option values.
const ON_OFF = [
  { value: "off", label: "Thinking Off" },
  { value: "on", label: "Thinking On" }
];

describe("reasoningValueForThoughtLevel", () => {
  it("maps low-effort tokens to the OFF-like value", () => {
    for (const token of ["low", "off", "none", "minimal", "min", "minimum", "fast"]) {
      expect(reasoningValueForThoughtLevel(token, ON_OFF)).toBe("off");
    }
  });

  it("maps high-effort tokens to the ON-like value", () => {
    for (const token of ["high", "on", "medium", "max", "maximum", "full", "think"]) {
      expect(reasoningValueForThoughtLevel(token, ON_OFF)).toBe("on");
    }
  });

  it("is case-insensitive", () => {
    expect(reasoningValueForThoughtLevel("LOW", ON_OFF)).toBe("off");
    expect(reasoningValueForThoughtLevel("High", ON_OFF)).toBe("on");
  });

  it("returns undefined for tokens that aren't an effort signal", () => {
    expect(reasoningValueForThoughtLevel("banana", ON_OFF)).toBeUndefined();
    expect(reasoningValueForThoughtLevel("", ON_OFF)).toBeUndefined();
  });

  it("falls back to the LOW graded level when the agent offers no off", () => {
    // Kimi K3: graded levels, no way to switch thinking off.
    const graded = [
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
      { value: "max", label: "Max" },
      { value: "on", label: "On" }
    ];
    expect(reasoningValueForThoughtLevel("low", graded)).toBe("low");
    expect(reasoningValueForThoughtLevel("high", graded)).toBe("high");
  });

  it("keeps a value that reads as on as on, even with a low-word in its label", () => {
    const labelled = [
      { value: "on", label: "On (minimal budget)" },
      { value: "off", label: "Off" }
    ];
    expect(reasoningValueForThoughtLevel("high", labelled)).toBe("on");
    expect(reasoningValueForThoughtLevel("low", labelled)).toBe("off");
  });

  it("prefers off over a graded low level when both are offered", () => {
    const both = [
      { value: "off", label: "Off" },
      { value: "low", label: "Low" },
      { value: "high", label: "High" }
    ];
    expect(reasoningValueForThoughtLevel("low", both)).toBe("off");
  });

  it("returns undefined when the option has no value of the needed polarity", () => {
    // Only an ON-like value exists → a low-effort request can't be satisfied.
    expect(reasoningValueForThoughtLevel("low", [{ value: "on", label: "On" }])).toBeUndefined();
  });

  it("classifies enabled/disabled vocabulary too", () => {
    const enabledDisabled = [
      { value: "disabled", label: "Reasoning disabled" },
      { value: "enabled", label: "Reasoning enabled" }
    ];
    expect(reasoningValueForThoughtLevel("low", enabledDisabled)).toBe("disabled");
    expect(reasoningValueForThoughtLevel("high", enabledDisabled)).toBe("enabled");
  });
});
