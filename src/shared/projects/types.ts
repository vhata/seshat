export type FieldKind = "file" | "key" | "owner" | "laptop" | "survey-date" | "unknown";
export interface IndexField { label: string; kind: FieldKind; value: string; line: number }
export interface IndexEntry { name: string; line: number; key?: string; fields: IndexField[]; summary: string }
export interface IndexSection { name: string; line: number; notes: string; entries: IndexEntry[] }
export interface IndexProblem { code: string; severity: "error" | "warning"; line: number; entry?: string; message: string }
export interface ProjectIndex { format: number; preamble: string; fields: IndexField[]; sections: IndexSection[]; problems: IndexProblem[] }
