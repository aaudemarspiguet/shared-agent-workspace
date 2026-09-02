// The launch resolver (extracted after review of #200/#205 found the wake
// adapter had reintroduced the #179 Windows shim bug with zero coverage).
// The POSIX path is byte-identical passthrough; the cmd quoting is pure and
// testable on any platform.
import { describe, expect, it } from "vitest";
import { launchFor, quoteForCmd } from "../src/launch.js";

describe("launchFor", () => {
  it("passes a bare name through untouched on POSIX", () => {
    if (process.platform === "win32") return;
    expect(launchFor("claude", ["-p", "hi"])).toEqual({
      file: "claude",
      args: ["-p", "hi"],
      shell: false
    });
  });

  it("quotes for cmd.exe by doubling quotes", () => {
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
    expect(quoteForCmd("plain")).toBe('"plain"');
  });
});
