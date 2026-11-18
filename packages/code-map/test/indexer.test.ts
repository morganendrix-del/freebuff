import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createCodeMapService, indexRepository, queryCodeMap } from "../src/index";
import type { CodeMap } from "../src/types";

let root: string;
let map: CodeMap;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "code-map-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "junk"), { recursive: true });

  await writeFile(
    path.join(root, "src", "math.ts"),
    [
      "export interface Vector {",
      "  x: number;",
      "}",
      "",
      "export function add(left: number, right: number): number {",
      "  return left + right;",
      "}",
      "",
      "function helper(value: number): number {",
      "  return add(value, 1);",
      "}",
      "",
      "export class Calculator {",
      "  total = 0;",
      "  add(value: number): void {",
      "    this.total = add(this.total, value);",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  await writeFile(
    path.join(root, "src", "index.ts"),
    [
      'import { add } from "./math";',
      "",
      "export const total = add(1, 2);",
      "export type Total = number;",
      "",
    ].join("\n"),
  );

  await writeFile(path.join(root, "README.md"), "# not source\n");
  await writeFile(
    path.join(root, "node_modules", "junk", "index.ts"),
    "export const ignored = 1;\n",
  );

  map = await indexRepository({ root });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("indexRepository", () => {
  test("indexes source files only, with repo-relative paths", () => {
    expect(map.files).toEqual(["src/index.ts", "src/math.ts"]);
    expect(map.symbols.some((symbol) => symbol.file.includes("node_modules"))).toBe(false);
  });

  test("extracts exports, declarations and methods with line numbers", () => {
    const looks = (name: string) => map.symbols.filter((symbol) => symbol.name === name);

    expect(
      looks("add")
        .map((symbol) => symbol.kind)
        .sort(),
    ).toEqual(["function", "method"]);
    expect(looks("Vector")[0]).toMatchObject({ kind: "interface", file: "src/math.ts", line: 1 });
    expect(looks("Calculator")[0]).toMatchObject({ kind: "class", exported: true });
    expect(looks("total").some((symbol) => symbol.exported)).toBe(true);
    expect(looks("Total")[0]).toMatchObject({ kind: "type", file: "src/index.ts" });
    expect(looks("helper")[0]?.exported).toBe(false);
  });

  test("records cross-file references", () => {
    const references = map.references.filter((reference) => reference.name === "add");
    expect(references.some((reference) => reference.file === "src/index.ts")).toBe(true);
    expect(references.some((reference) => reference.file === "src/math.ts")).toBe(true);
  });
});

describe("queries", () => {
  test("finds symbols by name and file", () => {
    const byName = queryCodeMap(map, { kind: "symbols", name: "calc" });
    expect(byName.symbols.map((symbol) => symbol.name)).toContain("Calculator");

    const byFile = queryCodeMap(map, { kind: "symbols", file: "src/index.ts" });
    expect(byFile.symbols.every((symbol) => symbol.file === "src/index.ts")).toBe(true);
  });

  test("returns a file outline in line order", () => {
    const outline = queryCodeMap(map, { kind: "outline", file: "src/math.ts" });
    const lines = outline.symbols.map((symbol) => symbol.line);
    expect([...lines].sort((left, right) => left - right)).toEqual(lines);
    expect(outline.symbols[0]?.name).toBe("Vector");
  });

  test("resolves references and lists files", () => {
    const references = queryCodeMap(map, { kind: "references", name: "Calculator" });
    expect(references.symbols).toHaveLength(1);
    expect(queryCodeMap(map, { kind: "files" }).files).toEqual(["src/index.ts", "src/math.ts"]);
  });

  test("the service wraps the same query surface", () => {
    const service = createCodeMapService(map);
    expect(service.query({ kind: "outline", file: "src/index.ts" }).symbols.length).toBeGreaterThan(
      0,
    );
  });
});
