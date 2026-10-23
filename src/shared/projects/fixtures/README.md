# Project-index conformance fixtures

Every input `.md` file here except this README has a matching `.json`
containing its full expected parse. Other implementations can run these
pairs without a TypeScript test runner. JSON problem messages are explanatory;
the format guarantees the code, severity, line and optional entry name.

- `example` is the complete fictional example from `docs/INDEX_FORMAT.md`.
- `source-markdown` preserves free Markdown, multiple paragraphs and nested
  lists; removes only fields and dividers; reads heading inline markup; and
  keeps quoted, fenced and lower-level headings as content.
- `errors` covers structural, key, field and date errors, duplicate reporting,
  unknown labels (including JavaScript property names), and recoverable output.
- `misplaced` covers section-note and later-list fields, fields embedded in
  another value, empty fields, undated laptop observations and setext headings.
- `heading-text` compares inline HTML and Markdown heading text, including
  headings whose text is empty after removing markup.

The test runner also exercises malformed UTF-8 bytes (which cannot be stored
as ordinary UTF-8 Markdown fixtures), BOM and CRLF normalization, exact value
grammars, case comparisons, indentation, lazy continuation and empty input.
