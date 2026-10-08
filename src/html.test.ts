import { describe, expect, it } from "vitest";
import { esc } from "./html";

describe("esc", () => {
  it("escapes HTML-significant characters", () => {
    expect(esc(`<img src=x onerror="a('b')">&`)).toBe(
      "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(esc("Expedition Tablet")).toBe("Expedition Tablet");
  });
});
