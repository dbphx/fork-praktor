import { describe, it, expect } from "vitest";
import { inferTerminalReason } from "../index.js";

describe("inferTerminalReason", () => {
  it("returns undefined for generic errors", () => {
    expect(inferTerminalReason("connection refused")).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(inferTerminalReason("")).toBeUndefined();
  });

  it("classifies max-turns errors as max_turns", () => {
    expect(
      inferTerminalReason("Reached maximum number of turns: 200")
    ).toBe("max_turns");
  });

  it("matches max-turns case-insensitively", () => {
    expect(inferTerminalReason("MAXIMUM NUMBER OF TURNS exceeded")).toBe(
      "max_turns"
    );
  });

  it("classifies blocking-limit errors", () => {
    expect(
      inferTerminalReason("Blocking limit reached for this prompt")
    ).toBe("blocking_limit");
  });

  it("matches 'blocking ... limit' with words between", () => {
    expect(inferTerminalReason("blocking token limit hit")).toBe(
      "blocking_limit"
    );
  });

  it("classifies abort errors", () => {
    expect(inferTerminalReason("Operation was aborted by user")).toBe(
      "aborted_tools"
    );
  });

  it("matches 'abort' anywhere in the message", () => {
    expect(inferTerminalReason("AbortError: signal raised")).toBe(
      "aborted_tools"
    );
  });

  it("prefers max_turns over blocking_limit when both terms appear", () => {
    // Order of checks in implementation
    expect(
      inferTerminalReason("blocking limit reached after maximum number of turns")
    ).toBe("max_turns");
  });
});
