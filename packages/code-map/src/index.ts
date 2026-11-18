import type { CodeMap, CodeMapQuery, CodeMapQueryResult, CodeMapService } from "./types";

export * from "./indexer";
export * from "./types";

/** Read-only query surface over an index built by `indexRepository`. */
export function createCodeMapService(map: CodeMap): CodeMapService {
  return {
    query: (query) => queryCodeMap(map, query),
  };
}

export function queryCodeMap(map: CodeMap, query: CodeMapQuery): CodeMapQueryResult {
  switch (query.kind) {
    case "files":
      return { kind: "files", files: map.files, symbols: [], references: [], truncated: false };

    case "outline":
      return {
        kind: "outline",
        files: [query.file],
        symbols: map.symbols
          .filter((symbol) => symbol.file === query.file)
          .sort((left, right) => left.line - right.line),
        references: [],
        truncated: false,
      };

    case "references": {
      const references = map.references.filter((reference) => reference.name === query.name);
      return {
        kind: "references",
        files: [...new Set(references.map((reference) => reference.file))],
        symbols: map.symbols.filter((symbol) => symbol.name === query.name),
        references,
        truncated: references.length >= 200,
      };
    }

    case "symbols": {
      const symbols = map.symbols.filter((symbol) => {
        if (
          query.name !== undefined &&
          !symbol.name.toLowerCase().includes(query.name.toLowerCase())
        ) {
          return false;
        }
        if (query.file !== undefined && symbol.file !== query.file) return false;
        return true;
      });
      return {
        kind: "symbols",
        files: [...new Set(symbols.map((symbol) => symbol.file))],
        symbols,
        references: [],
        truncated: symbols.length >= 500,
      };
    }
  }
}

/** Renders a query result as compact text for the model. */
export function formatCodeMapResult(result: CodeMapQueryResult): string {
  if (result.kind === "files") {
    return result.files.map((file) => `- ${file}`).join("\n");
  }
  if (result.kind === "references") {
    return result.references
      .map((reference) => `${reference.file}:${String(reference.line)}  ${reference.name}`)
      .join("\n");
  }
  return result.symbols
    .map(
      (symbol) =>
        `${symbol.file}:${String(symbol.line)}  ${symbol.kind} ${symbol.name}${symbol.exported ? " (exported)" : ""}`,
    )
    .join("\n");
}
