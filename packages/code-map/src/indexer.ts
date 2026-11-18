import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { CodeMap, RepoSymbol, SymbolKind, SymbolReference } from "./types";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_REFERENCES_PER_SYMBOL = 200;

interface SymbolPattern {
  readonly pattern: RegExp;
  readonly kind: SymbolKind;
  readonly exported: boolean;
}

const LINE_PATTERNS: readonly SymbolPattern[] = [
  {
    pattern: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    kind: "function",
    exported: true,
  },
  { pattern: /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function", exported: false },
  {
    pattern: /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: "class",
    exported: true,
  },
  { pattern: /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", exported: false },
  { pattern: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", exported: true },
  { pattern: /^\s*interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", exported: false },
  { pattern: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type", exported: true },
  { pattern: /^\s*type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type", exported: false },
  { pattern: /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "const", exported: true },
  { pattern: /^\s*const\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "const", exported: false },
];

const METHOD_PATTERN =
  /^\s{2,}(?:(?:public|private|protected|static|readonly)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/;
const METHOD_KEYWORDS = new Set([
  "catch",
  "constructor",
  "do",
  "else",
  "for",
  "if",
  "return",
  "switch",
  "try",
  "while",
]);

async function listSourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }

      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      const info = await stat(absolute);
      if (info.size > MAX_FILE_BYTES) continue;
      found.push(absolute);
    }
  };

  await walk(root);
  return found;
}

function toRepoPath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function extractSymbols(file: string, contents: string): RepoSymbol[] {
  const symbols: RepoSymbol[] = [];
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (
      line.trim() === "" ||
      line.trimStart().startsWith("//") ||
      line.trimStart().startsWith("*")
    ) {
      continue;
    }

    let matched = false;
    for (const { pattern, kind, exported } of LINE_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.[1] === undefined) continue;

      const name = match[1];
      symbols.push({
        id: `${file}#${kind}:${name}.${String(index + 1)}`,
        name,
        kind,
        file,
        line: index + 1,
        exported,
      });
      matched = true;
      break;
    }

    if (matched) continue;
    const methodMatch = METHOD_PATTERN.exec(line);
    const methodName = methodMatch?.[1];
    if (methodName === undefined || METHOD_KEYWORDS.has(methodName)) continue;

    symbols.push({
      id: `${file}#method:${methodName}.${String(index + 1)}`,
      name: methodName,
      kind: "method",
      file,
      line: index + 1,
      exported: false,
    });
  }

  return symbols;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

function findReferences(
  file: string,
  contents: string,
  names: readonly string[],
  declarations: ReadonlySet<string>,
): SymbolReference[] {
  const references: SymbolReference[] = [];
  const lines = contents.split(/\r?\n/);

  for (const name of names) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    let count = 0;

    for (let index = 0; index < lines.length; index += 1) {
      if (count >= MAX_REFERENCES_PER_SYMBOL) break;
      const line = lines[index] ?? "";
      if (!pattern.test(line)) continue;
      pattern.lastIndex = 0;

      const key = `${file}:${String(index + 1)}:${name}`;
      if (declarations.has(key)) continue;
      if (line.trimStart().startsWith("//")) continue;

      references.push({ name, file, line: index + 1 });
      count += 1;
    }
  }

  return references;
}

export interface IndexOptions {
  readonly root: string;
  readonly maxFiles?: number;
}

/** Builds a lightweight symbol graph for a repository. Pure filesystem + regex; no native deps. */
export async function indexRepository(options: IndexOptions): Promise<CodeMap> {
  const root = path.resolve(options.root);
  const absoluteFiles = (await listSourceFiles(root)).slice(0, options.maxFiles ?? 5_000);
  const files = absoluteFiles.map((absolute) => toRepoPath(root, absolute));

  const contentsByFile = new Map<string, string>();
  const symbols: RepoSymbol[] = [];

  for (const absolute of absoluteFiles) {
    const file = toRepoPath(root, absolute);
    const contents = await readFile(absolute, "utf8");
    contentsByFile.set(file, contents);
    symbols.push(...extractSymbols(file, contents));
  }

  const names = [...new Set(symbols.map((symbol) => symbol.name))];
  const declarationKeys = new Set(
    symbols.map((symbol) => `${symbol.file}:${String(symbol.line)}:${symbol.name}`),
  );

  const references: SymbolReference[] = [];
  for (const file of files) {
    const contents = contentsByFile.get(file) ?? "";
    references.push(...findReferences(file, contents, names, declarationKeys));
  }

  return {
    root,
    generatedAt: new Date().toISOString(),
    files,
    symbols,
    references,
    truncatedReferences: references.length >= names.length * MAX_REFERENCES_PER_SYMBOL,
  };
}
