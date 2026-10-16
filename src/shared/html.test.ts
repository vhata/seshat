import { describe, expect, it } from "vitest";
import { escapeHtml, html } from "./html";

describe("html", () => {
  it("escapes every interpolated value", () => {
    expect(html`<p title="${'"><script>'}">${"<b>&'"}</p>`.value).toBe(
      '<p title="&quot;&gt;&lt;script&gt;">&lt;b&gt;&amp;&#39;</p>',
    );
  });

  it("passes nested fragments and lists through unescaped once", () => {
    const items = ["a<", "b"].map((item) => html`<li>${item}</li>`);
    expect(html`<ul>${items}</ul>${false}${null}`.value).toBe("<ul><li>a&lt;</li><li>b</li></ul>");
  });

  it("escapes the five significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
