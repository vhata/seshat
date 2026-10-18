import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProjectIndex } from "./index.ts";
import type { ProjectIndex } from "./types.ts";

const fixtureRoot = new URL("./fixtures/", import.meta.url);
const fixtures = readdirSync(fixtureRoot).filter((name) => name.endsWith(".md") && name !== "README.md");

describe("project-index conformance fixtures", () => {
  for (const name of fixtures) {
    it(name, () => {
      const bytes = readFileSync(new URL(name, fixtureRoot));
      const expected = JSON.parse(readFileSync(new URL(name.replace(/\.md$/, ".json"), fixtureRoot), "utf8")) as ProjectIndex;
      expect(parseProjectIndex(bytes)).toEqual(expected);
      expect(parseProjectIndex(bytes.toString("utf8"))).toEqual(expected);
    });
  }

  it("does not depend on the line endings or a leading byte-order mark", () => {
    for (const name of fixtures) {
      const input = readFileSync(new URL(name, fixtureRoot), "utf8");
      const expected = parseProjectIndex(input);
      expect(parseProjectIndex(`\uFEFF${input.replace(/\n/g, "\r\n")}`)).toEqual(expected);
      expect(parseProjectIndex(new TextEncoder().encode(`\uFEFF${input.replace(/\n/g, "\r\n")}`))).toEqual(expected);
    }
  });
});

function entry(fields: string) {
  return parseProjectIndex(`## Active\n\n### kiln\n\n${fields}\n`);
}

function codes(result: ProjectIndex) {
  return result.problems.map((problem) => problem.code);
}

describe("project-index syntax and values", () => {
  it.each([
    [0xff], [0xc3, 0x28], [0xed, 0xa0, 0x80], [0xe2, 0x82],
    [0xc0, 0x80], [0xf4, 0x90, 0x80, 0x80],
  ])("rejects malformed UTF-8 bytes %j instead of substituting characters", (...bytes) => {
    const result = parseProjectIndex(new Uint8Array(bytes));
    expect(result.problems).toEqual([{
      code: "not-utf8", severity: "error", line: 1,
      message: "The index is not valid UTF-8.",
    }]);
    expect(result.sections).toEqual([]);
  });

  it("keeps a valid Unicode replacement character and non-ASCII Markdown", () => {
    const parsed = entry("- Path: café\n- Note: 🔥 \uFFFD");
    expect(parsed.problems).toEqual([]);
    expect(parsed.sections[0]!.entries[0]!.key).toBe("path:café");
    expect(parsed.sections[0]!.entries[0]!.fields[1]!.value).toBe("🔥 \uFFFD");
  });

  it("normalizes exactly one leading BOM for both input forms", () => {
    const input = "\uFEFF\uFEFF## Active\n\n### kiln\n\n- Path: kiln\n";
    expect(parseProjectIndex(new TextEncoder().encode(input))).toEqual(parseProjectIndex(input));
    expect(parseProjectIndex(input).preamble).toContain("\uFEFF## Active");
  });

  it.each(["2024-02-29", "2000-02-29", "0001-01-01", "9999-12-31"])("accepts real calendar date %s", (date) => {
    expect(entry(`- Path: kiln\n- Surveyed: ${date}`).problems).toEqual([]);
  });

  it.each(["1900-02-29", "2100-02-29", "0000-01-01", "2026-04-31", "2026-00-01", "2026-01-00", "2026-1-01", "2026-01-01 commentary"])("rejects non-date %s", (date) => {
    expect(codes(entry(`- Path: kiln\n- Surveyed: ${date}`))).toEqual(["invalid-survey-date"]);
  });

  it.each(["/absolute", "~/home", "folder/", ".", "..", "a/./b", "a/../b", "a\\b", "C:/absolute"])("excludes invalid path %s from keys and duplicate-path checks", (path) => {
    const parsed = parseProjectIndex(`## Active\n### a\n- Path: ${path}\n### b\n- Path: ${path}\n`);
    expect(codes(parsed)).toEqual(["missing-key", "invalid-path", "missing-key", "invalid-path"]);
    expect(parsed.sections[0]!.entries.every((item) => item.key === undefined)).toBe(true);
  });

  it.each(["owner/.", "owner/..", "/name", "owner/", "owner/a b", "owner/name.", "none.", "git@example.invalid:owner/name", "https://github.com/owner/name", "owner/name with commentary", `${"a".repeat(40)}/name`])("checks remote %s against the exact join-key grammar", (remote) => {
    // A trailing full stop is legal in a repository name; commentary and a
    // full stop after the special word 'none' are not.
    const parsed = entry(`- Remote: ${remote}\n- Path: kiln`);
    expect(codes(parsed)).toEqual(remote === "owner/name." ? [] : ["invalid-remote"]);
    expect(parsed.sections[0]!.entries[0]!.key).toBe(remote === "owner/name." ? "remote:owner/name." : "path:kiln");
  });

  it("supports a remote-only entry and case-insensitive none", () => {
    const remote = entry("- Remote: `Owner/Repo_name-1.2`");
    expect(remote.problems).toEqual([]);
    expect(remote.sections[0]!.entries[0]!.key).toBe("remote:owner/repo_name-1.2");
    const local = entry("- Remote: `NoNe`\n- Path: kiln");
    expect(local.problems).toEqual([]);
    expect(local.sections[0]!.entries[0]!.key).toBe("path:kiln");
  });

  it("compares paths and display names exactly, remote names ignoring case", () => {
    const result = parseProjectIndex("## Active\n### A\n- Remote: o/r\n- Path: A\n## active\n### a\n- Remote: O/R\n- Path: a\n");
    expect(codes(result)).toEqual(["duplicate-remote"]);
    expect(result.sections.map((section) => section.name)).toEqual(["Active", "active"]);
  });

  it("removes inline HTML and Markdown before comparing headings", () => {
    const result = parseProjectIndex("## <b>Active</b>\n### <i>Project</i>\n- Path: first\n## **Active**\n### `Project`\n- Path: second\n## <span></span>\n### <em></em>\n- Path: third\n");
    expect(result.sections.map((section) => section.name)).toEqual(["Active", "Active", ""]);
    expect(result.sections.flatMap((section) => section.entries).map((project) => project.name)).toEqual(["Project", "Project", ""]);
    expect(codes(result)).toEqual(["duplicate-section", "duplicate-name", "empty-heading", "empty-heading"]);
  });

  it("does not search for a later colon when the first one cannot label a field", () => {
    const parsed = entry("- Path: kiln\n- A kiln scheduler. Rewritten 2026-09: kept\n- https://example.invalid: still description\n- Stack:\talso description\n- 2 invalid: description\n- Valid-label: unknown field\n- last   COMMIT: free-form value\n- Surveyed: 2026-10-01");
    const project = parsed.sections[0]!.entries[0]!;
    expect(project.summary).toBe("A kiln scheduler. Rewritten 2026-09: kept\n\nhttps://example.invalid: still description\n\nStack:\talso description\n\n2 invalid: description");
    expect(project.fields.map((field) => field.label)).toEqual(["Path", "Valid-label", "Last commit", "Surveyed"]);
    expect(codes(parsed)).toEqual(["unknown-field"]);
  });

  it("uses the first top-level bullet list even when a later one looks more like fields", () => {
    const parsed = entry("Before.\n\n- A description\n\nBetween.\n\n- Path: ignored\n");
    expect(codes(parsed)).toEqual(["missing-key", "misplaced-field"]);
    expect(parsed.sections[0]!.entries[0]!.summary).toBe("Before.\n\nA description\n\nBetween.\n\n- Path: ignored");
    expect(parsed.sections[0]!.entries[0]!.fields).toEqual([]);
  });

  it("ignores empty fields, including empty unknown fields and repeats", () => {
    const parsed = entry("- Path:\n- Path: kiln\n- Remote:\n- Stack:\n- Unknown:\n- Surveyed:");
    expect(parsed.problems).toEqual([]);
    expect(parsed.sections[0]!.entries[0]!.fields).toEqual([{ label: "Path", kind: "key", value: "kiln", line: 6 }]);
    expect(parsed.sections[0]!.entries[0]!.summary).toBe("");
  });

  it("handles content indentation, tabs, lazy continuations and nested Markdown", () => {
    const parsed = entry("  *\tPath: kiln\n  * Note: first\n         extra indent\nlazy continuation\n\n    - nested\n  * description\n    continued\n");
    expect(parsed.problems).toEqual([]);
    expect(parsed.sections[0]!.entries[0]!.fields[1]!.value).toBe("first\n     extra indent\nlazy continuation\n\n- nested");
    expect(parsed.sections[0]!.entries[0]!.summary).toBe("description\ncontinued");
  });

  it("does not promote nested headings or ordered/quoted lists into entry fields", () => {
    const parsed = entry(
      "> - Path: quoted\n>\n> ## nested heading\n\n1. Ordered item\n\n```\n## fenced\n```\n\n- Path: kiln\n  - nested\n    ### nested entry\n\n- Note: owner\n",
    );
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.entries).toHaveLength(1);
    expect(parsed.sections[0]!.entries[0]!.fields.map((field) => field.label)).toEqual(["Path", "Note"]);
    expect(parsed.sections[0]!.entries[0]!.summary).toContain("> ## nested heading");
  });

  it("accepts an empty document without inventing fields or sections", () => {
    expect(parseProjectIndex("")).toEqual({ format: 1, preamble: "", fields: [], sections: [], problems: [] });
  });
});
