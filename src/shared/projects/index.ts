import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";
import type { List, ListItem, RootContent } from "mdast";
import type { FieldKind, IndexEntry, IndexField, IndexSection, ProjectIndex } from "./types.ts";

export type { FieldKind, IndexEntry, IndexField, IndexProblem, IndexSection, ProjectIndex } from "./types.ts";

const entryDefinitions: Record<string, { label: string; kind: FieldKind }> = {
  remote: { label: "Remote", kind: "key" },
  path: { label: "Path", kind: "key" },
  next: { label: "Next", kind: "owner" },
  note: { label: "Note", kind: "owner" },
  stack: { label: "Stack", kind: "laptop" },
  started: { label: "Started", kind: "laptop" },
  "last commit": { label: "Last commit", kind: "laptop" },
  "checked out": { label: "Checked out", kind: "laptop" },
  branches: { label: "Branches", kind: "laptop" },
  unpushed: { label: "Unpushed", kind: "laptop" },
  uncommitted: { label: "Uncommitted", kind: "laptop" },
  surveyed: { label: "Surveyed", kind: "survey-date" },
};

interface LabelledItem {
  label: string;
  normalized: string;
  value: string;
  line: number;
  valueLine: number;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function entryDefinition(label: string): { label: string; kind: FieldKind } | undefined {
  return Object.hasOwn(entryDefinitions, label) ? entryDefinitions[label] : undefined;
}

function trimBlankLines(source: string): string {
  return source.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

function unquote(value: string): string {
  return /^`[^`]*`$/.test(value) ? value.slice(1, -1) : value;
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

/** A deterministic, source-preserving reader for docs/INDEX_FORMAT.md. */
export function parseProjectIndex(input: string | Uint8Array): ProjectIndex {
  const result: ProjectIndex = { format: 1, preamble: "", fields: [], sections: [], problems: [] };
  let source: string;
  try {
    // Preserve the BOM during decoding so both input forms remove exactly
    // one leading BOM in the common normalization step below.
    source = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    result.problems.push({ code: "not-utf8", severity: "error", line: 1, message: "The index is not valid UTF-8." });
    return result;
  }
  source = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

  function problem(code: string, severity: "error" | "warning", line: number, message: string, entry?: string): void {
    result.problems.push({ code, severity, line, ...(entry === undefined ? {} : { entry }), message });
  }

  function nodeSource(node: RootContent | ListItem): string {
    return lines.slice(node.position!.start.line - 1, node.position!.end.line).join("\n");
  }

  // CommonMark expands tabs to four-column tab stops for list indentation.
  function removeIndent(line: string, width: number, startColumn = 0): string {
    let column = startColumn;
    const target = startColumn + width;
    let index = 0;
    while (index < line.length && column < target) {
      const char = line[index];
      if (char === " ") column++;
      else if (char === "\t") column += 4 - (column % 4);
      else break;
      index++;
    }
    return " ".repeat(Math.max(0, column - target)) + line.slice(index);
  }

  function itemText(item: ListItem): { text: string; line: number } {
    const line = item.position!.start.line;
    const raw = nodeSource(item).split("\n");
    const first = raw[0]!;
    const marker = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/.exec(first);
    if (!marker) return { text: raw.join("\n"), line };
    const markerEnd = marker[1]!.length + marker[2]!.length;
    let column = markerEnd;
    let start = markerEnd;
    while (start < first.length && /[ \t]/.test(first[start]!)) {
      column += first[start] === "\t" ? 4 - (column % 4) : 1;
      start++;
    }
    const indent = column - markerEnd > 4 ? markerEnd + 1 : column;
    const firstText = removeIndent(first.slice(markerEnd), indent - markerEnd, markerEnd);
    const text = [firstText, ...raw.slice(1).map((value) => removeIndent(value, indent))].join("\n");
    return { text, line };
  }

  function labelled(item: ListItem): LabelledItem | undefined {
    const { text, line } = itemText(item);
    const newline = text.indexOf("\n");
    let first = newline < 0 ? text : text.slice(0, newline);
    first = first.replace(/^\*\*([^*\n]*?:)\*\*/, "$1").replace(/^\*\*([^*\n]+)\*\*:/, "$1:");
    const colon = first.indexOf(":");
    if (colon < 0 || (first[colon + 1] !== undefined && first[colon + 1] !== " ")) return undefined;
    const label = first.slice(0, colon);
    if (!/^[A-Za-z][A-Za-z0-9 -]*$/.test(label)) return undefined;
    const rawValue = first.slice(colon + 1) + (newline < 0 ? "" : text.slice(newline));
    const value = rawValue.trim();
    const valueLine = line + (rawValue.match(/^\s*/)?.[0].match(/\n/g)?.length ?? 0);
    return { label, normalized: normalizeLabel(label), value, line, valueLine };
  }

  function boldMisplacements(value: string, line: number, entry?: string): void {
    for (const match of value.matchAll(/\*\*([A-Za-z][A-Za-z0-9 -]*):\*\*|\*\*([A-Za-z][A-Za-z0-9 -]*)\*\*:/g)) {
      const label = match[1] ?? match[2]!;
      if (entryDefinition(normalizeLabel(label)) || normalizeLabel(label) === "format") {
        problem("misplaced-field", "warning", line + value.slice(0, match.index).split("\n").length - 1,
          `${label} appears inside another field's value.`, entry);
      }
    }
  }

  function readFields(list: List, file: boolean, entry?: string): IndexField[] {
    const fields: IndexField[] = [];
    const seen = new Set<string>();
    for (const item of list.children) {
      const parsed = labelled(item);
      if (!parsed || !parsed.value) continue;
      const definition = file
        ? (parsed.normalized === "format" ? { label: "Format", kind: "file" as const } : undefined)
        : entryDefinition(parsed.normalized);
      const field: IndexField = {
        label: definition?.label ?? parsed.label,
        kind: definition?.kind ?? "unknown",
        value: definition && ["Remote", "Path", "Surveyed"].includes(definition.label) ? unquote(parsed.value) : parsed.value,
        line: parsed.line,
      };
      if (definition && seen.has(parsed.normalized)) {
        problem("duplicate-field", "error", parsed.line, `${field.label} appears more than once.`, entry);
      }
      seen.add(parsed.normalized);
      fields.push(field);
      if (!definition) problem("unknown-field", "warning", parsed.line, `Unrecognised field ${parsed.label}.`, entry);
      boldMisplacements(parsed.value, parsed.valueLine, entry);
      if (field.kind === "file") {
        if (field.value !== "1") problem("unsupported-format", "error", field.line, `Unsupported format ${field.value}.`);
        if (/^\d+$/.test(field.value) && Number.isSafeInteger(Number(field.value))) result.format = Number(field.value);
      }
      if (field.label === "Remote" && field.kind === "key" && !/^(?:none|[A-Za-z0-9-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9._-]+)$/i.test(field.value)) {
        problem("invalid-remote", "error", field.line, "Remote must be exactly owner/name or none.", entry);
      }
      if (field.label === "Path" && field.kind === "key" && (/^[\/~]/.test(field.value) || /\\/.test(field.value) || /\/$/.test(field.value) || /^[A-Za-z]:\//.test(field.value) || field.value.split("/").some((segment) => segment === "." || segment === ".."))) {
        problem("invalid-path", "error", field.line, "Path must be relative and use forward slashes without dot segments.", entry);
      }
      if (field.kind === "survey-date" && !validDate(field.value)) {
        problem("invalid-survey-date", "error", field.line, "Surveyed must be a real YYYY-MM-DD date.", entry);
      }
    }
    return fields;
  }

  function misplacedLists(nodes: RootContent[], selected: List | undefined, entry?: string): void {
    for (const node of nodes) {
      if (node.type !== "list" || node === selected) continue;
      for (const item of node.children) {
        const parsed = labelled(item);
        if (parsed && (entryDefinition(parsed.normalized) || parsed.normalized === "format")) {
          problem("misplaced-field", "warning", parsed.line, `${parsed.label} appears outside the field list.`, entry);
        }
      }
    }
  }

  // Preserve contiguous source regions; deleting a field list or divider is
  // the only reason to join two source regions with a new blank line.
  function content(nodes: RootContent[], selected?: List, preamble = false): string {
    const parts: string[] = [];
    let run: RootContent[] = [];
    function flush(): void {
      if (!run.length) return;
      parts.push(lines.slice(run[0]!.position!.start.line - 1, run.at(-1)!.position!.end.line).join("\n"));
      run = [];
    }
    for (const node of nodes) {
      if (node.type === "thematicBreak") { flush(); continue; }
      if (node === selected) {
        flush();
        for (const item of selected.children) {
          if (!labelled(item)) parts.push(preamble ? nodeSource(item) : itemText(item).text);
        }
      } else run.push(node);
    }
    flush();
    return parts.map(trimBlankLines).filter((part) => part.trim()).join("\n\n");
  }

  const names = new Set<string>();
  const remotes = new Set<string>();
  const paths = new Set<string>();
  const sectionNames = new Set<string>();
  let section: IndexSection | undefined;
  let entry: IndexEntry | undefined;
  let nodes: RootContent[] = [];

  function finish(): void {
    if (!section) {
      const selected = nodes.find((node): node is List => node.type === "list" && !node.ordered && !!node.children[0] && !!labelled(node.children[0]));
      if (selected) result.fields = readFields(selected, true);
      result.preamble = content(nodes, selected, true);
      misplacedLists(nodes, selected);
    } else if (!entry) {
      section.notes = content(nodes);
      misplacedLists(nodes, undefined);
    } else {
      const selected = nodes.find((node): node is List => node.type === "list" && !node.ordered);
      entry.fields = selected ? readFields(selected, false, entry.name) : [];
      entry.summary = content(nodes, selected);
      misplacedLists(nodes, selected, entry.name);
      const usable = (label: string) => entry!.fields.find((field) => field.label === label && field.kind === "key" && !result.problems.some((issue) => issue.line === field.line && issue.code === `invalid-${label.toLowerCase()}`));
      const remote = usable("Remote");
      const path = usable("Path");
      if (remote && remote.value.toLowerCase() !== "none") {
        const key = remote.value.toLowerCase();
        entry.key = `remote:${key}`;
        if (remotes.has(key)) problem("duplicate-remote", "error", remote.line, `Repository ${remote.value} appears more than once.`, entry.name);
        remotes.add(key);
      } else if (path) entry.key = `path:${path.value}`;
      else problem("missing-key", "error", entry.line, "Entry needs a repository Remote or a Path.", entry.name);
      if (path) {
        if (paths.has(path.value)) problem("duplicate-path", "error", path.line, `Path ${path.value} appears more than once.`, entry.name);
        paths.add(path.value);
      }
      if (entry.fields.some((field) => field.kind === "laptop") && !entry.fields.some((field) => field.kind === "survey-date")) {
        problem("missing-survey-date", "warning", entry.line, "Entry has laptop observations without Surveyed.", entry.name);
      }
    }
    nodes = [];
  }

  for (const node of tree.children) {
    if (node.type !== "heading") { nodes.push(node); continue; }
    const line = node.position!.start.line;
    const atx = /^ {0,3}#{1,6}(?:[ \t]|$)/.test(lines[line - 1]!);
    if (!atx) {
      problem("setext-heading", "error", line, "Use ATX headings with # markers.", entry?.name);
      nodes.push(node);
      continue;
    }
    const name = toString(node, { includeHtml: false }).replace(/\s+/g, " ").trim();
    if (node.depth === 2) {
      finish();
      section = { name, line, notes: "", entries: [] };
      entry = undefined;
      result.sections.push(section);
      if (!name) problem("empty-heading", "error", line, "Section heading is empty.");
      if (sectionNames.has(name)) problem("duplicate-section", "warning", line, `Section ${name} appears more than once.`);
      sectionNames.add(name);
    } else if (node.depth === 3) {
      if (!section) {
        problem("entry-outside-section", "error", line, "Entry appears before any section.", name);
        if (!name) problem("empty-heading", "error", line, "Entry heading is empty.", name);
        nodes.push(node);
        continue;
      }
      finish();
      entry = { name, line, fields: [], summary: "" };
      section.entries.push(entry);
      if (!name) problem("empty-heading", "error", line, "Entry heading is empty.", name);
      if (names.has(name)) problem("duplicate-name", "warning", line, `Entry ${name} appears more than once.`, name);
      names.add(name);
    } else {
      if (node.depth === 1 && section) problem("stray-title", "warning", line, "First-level heading appears after the preamble.", entry?.name);
      nodes.push(node);
    }
  }
  finish();
  result.problems.sort((left, right) => left.line - right.line || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  return result;
}
