export type SymbolKind = "class" | "const" | "function" | "interface" | "method" | "type";

export interface RepoSymbol {
  /** Stable identifier: `path#kind:name.line`. */
  readonly id: string;
  readonly name: string;
  readonly kind: SymbolKind;
  /** Repo-relative POSIX path. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  readonly exported: boolean;
}

export interface SymbolReference {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

export interface CodeMap {
  readonly root: string;
  readonly generatedAt: string;
  readonly files: readonly string[];
  readonly symbols: readonly RepoSymbol[];
  readonly references: readonly SymbolReference[];
  readonly truncatedReferences: boolean;
}

export type CodeMapQuery =
  | { readonly kind: "files" }
  | { readonly kind: "outline"; readonly file: string }
  | { readonly kind: "references"; readonly name: string }
  | { readonly kind: "symbols"; readonly name?: string; readonly file?: string };

export interface CodeMapQueryResult {
  readonly kind: CodeMapQuery["kind"];
  readonly files: readonly string[];
  readonly symbols: readonly RepoSymbol[];
  readonly references: readonly SymbolReference[];
  readonly truncated: boolean;
}

/** What the agent's `code_map_query` tool talks to. */
export interface CodeMapService {
  query(query: CodeMapQuery): CodeMapQueryResult;
}
