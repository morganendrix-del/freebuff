import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PREVIEW_SERVER = `import { createServer } from "node:http";

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><h1>freebuff preview ok</h1><p>" + request.url + "</p>");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log("Preview ready at http://localhost:" + address.port);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
`;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: "freebuff-preview-fixture",
    private: true,
    version: "1.0.0",
    packageManager: "bun@1.4.4",
    scripts: { dev: "node server.mjs" },
  },
  null,
  2,
)}\n`;

export interface FixtureRepository {
  /** `file://` URL of a bare clone, standing in for github.com/acme/demo.git. */
  readonly cloneUrl: string;
  readonly base: string;
  readonly cleanup: () => Promise<void>;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=freebuff", "-c", "user.email=ci@freebuff.example", ...args],
    { cwd, stdio: "pipe" },
  );
}

/**
 * Builds a tiny repository with a real dev server and a bare clone of it, so the gate exercises the
 * exact production path (git clone over a URL → detect → install → launch → probe) without depending
 * on github.com availability during tests.
 */
export async function createFixtureRepository(): Promise<FixtureRepository> {
  const base = await mkdtemp(path.join(tmpdir(), "freebuff-gate-"));
  const source = path.join(base, "source");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "package.json"), PACKAGE_JSON, "utf8");
  await writeFile(path.join(source, "server.mjs"), PREVIEW_SERVER, "utf8");
  await writeFile(path.join(source, "README.md"), "# demo\n", "utf8");

  git(source, ["init", "--quiet", "--initial-branch=main"]);
  git(source, ["add", "--all"]);
  git(source, ["commit", "--quiet", "-m", "fixture"]);
  git(base, ["clone", "--quiet", "--bare", source, "demo.git"]);

  return {
    base,
    cloneUrl: `file://${path.join(base, "demo.git")}`,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  options: { readonly timeoutMs: number; readonly intervalMs?: number } = { timeoutMs: 30_000 },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for a condition.");
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 100));
  }
}
