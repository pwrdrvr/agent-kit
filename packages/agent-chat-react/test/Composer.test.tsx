import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "../src/index";

afterEach(() => {
  cleanup();
});

describe("Composer", () => {
  it("submits typed text on Enter and clears the input", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSubmit={onSubmit} />);

    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello agent" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("hello agent");

    await waitFor(() => {
      expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("submits on send-button click", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSubmit={onSubmit} />);

    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "click submit" }
    });
    fireEvent.click(screen.getByTestId("composer-send"));

    expect(onSubmit).toHaveBeenCalledWith("click submit");
  });

  it("does not submit whitespace-only input", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSubmit={onSubmit} />);

    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "   \n  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("inserts a newline (no submit) on Shift+Enter", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSubmit={onSubmit} />);

    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables the input and send button while disabled", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSubmit={onSubmit} disabled />);

    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    const send = screen.getByTestId("composer-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("disables the textarea while streaming and shows an interrupt button", () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onInterrupt = vi.fn();
    render(<Composer onSubmit={onSubmit} streaming onInterrupt={onInterrupt} />);

    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);

    const interrupt = screen.getByTestId("composer-interrupt");
    fireEvent.click(interrupt);
    expect(onInterrupt).toHaveBeenCalledTimes(1);

    // The send button is replaced by the interrupt button while streaming.
    expect(screen.queryByTestId("composer-send")).toBeNull();
  });

  it("guards against double-submit while a send is in flight", async () => {
    let resolve!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        })
    );
    render(<Composer onSubmit={onSubmit} />);

    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Second Enter before the first settles is a no-op.
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() => {
      expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("keeps the draft when onSubmit rejects", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("boom"));
    render(<Composer onSubmit={onSubmit} />);

    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "keep me" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("keep me");
    // Draft survives the rejection.
    await waitFor(() => {
      expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe(
        "keep me"
      );
    });
  });
});
