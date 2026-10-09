import { describe, expect, it } from "vitest";
import { parseChangelog } from "./changelog";

describe("parseChangelog", () => {
  it("skips the Unreleased section and its bullets", () => {
    const raw = "# Notes\n\nintro\n\n## Unreleased\n\n- draft\n\n## 1.0.0\n\n- shipped\n\n## 0.9.0\n\n- older\n";
    expect(parseChangelog(raw)).toEqual([
      { version: "1.0.0", bullets: ["shipped"] },
      { version: "0.9.0", bullets: ["older"] },
    ]);
  });

  it("never shows Unreleased from the bundled CHANGELOG", () => {
    expect(parseChangelog().some((s) => s.version.toLowerCase() === "unreleased")).toBe(false);
  });
});
