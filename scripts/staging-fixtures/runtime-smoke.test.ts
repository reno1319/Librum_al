import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PHASE-1C runtime correction: this file exists because the ordinary
// vitest suite CANNOT catch the class of bug that broke the first real
// local invocation of these scripts -- vitest transforms every .ts/.mts
// file with vite/esbuild, which fully compiles TypeScript (parameter
// properties included) before Node ever sees the code. The scripts'
// actual documented runtime (`node --experimental-strip-types` against
// the raw .mts source -- see package.json's staging:fixtures:* scripts
// and this directory's README.md "Runtime" section) uses Node's OWN
// native type stripping instead, which supports only ERASABLE
// TypeScript syntax -- constructs that can be deleted without changing
// program behavior. A constructor parameter property
// (`constructor(public readonly x: string, ...)`) is not erasable: it
// both declares a field AND assigns it, so it requires actual code
// generation, and Node's strip-only mode rejects it with
// SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]. Every other
// vitest-covered test in this directory could pass while this exact
// failure mode went completely undetected, because none of them ever
// executed the source through a real, unmodified Node process the way
// `npm run staging:fixtures:seed` actually does. This test closes that
// specific gap, permanently, by doing exactly that.
//
// Reproduced directly against the originally-failing code (git commit
// 93c539d04000c012843863f1bd689df881bf62b0) using the exact reported
// runtime (Node v26.7.0) and independently against Node v22.6.0 (this
// directory's documented minimum) and v22.22.2 (this environment's
// installed default) -- all three rejected the parameter properties
// identically. The fix (ordinary field declaration + constructor
// assignment, same public readonly typing, zero behavior change)
// verified clean on all three. This test intentionally does NOT pin a
// specific Node version -- it spawns `process.execPath`, i.e. whatever
// Node is actually running the suite, so it keeps catching this same
// class of regression permanently, on whatever Node version CI or a
// developer's machine happens to run, without ever needing network
// access to fetch a pinned version.
//
// What this test proves: the entire runtime import graph of seed.mts,
// reset.mts, and live-deps.mts (which transitively pulls in every other
// .mts file in this directory plus the one external dependency,
// ../../src/lib/supabase/env-guard.ts -- see each file's own import
// list) parses and loads end-to-end under Node's native, unmodified
// `--experimental-strip-types`, with nothing beyond a bare `import()`
// of each file. It does NOT invoke any CLI entry point (every one of
// seed.mts/reset.mts's `if (import.meta.url === \`file://${process.argv[1]}\`)`
// blocks stays false here, since these files are imported as modules,
// never run as the process's own entry point -- confirmed by the child
// process argv used below), construct a Supabase client (guard.mts's
// assertStagingTargetFromEnv() and the real client factories in
// live-deps.mts are only ever called from inside functions, never at
// module scope -- importing triggers zero calls into either), read any
// credential (no env file is passed to the child process at all, and
// none of STAGING_FIXTURE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
// STAGING_FIXTURE_AUTHOR_PASSWORD / STAGING_FIXTURE_READER_PASSWORD are
// read during import), or make any network call.
describe("runtime smoke test: real Node --experimental-strip-types import graph", () => {
  it("loads seed.mts, reset.mts, and live-deps.mts end-to-end with no errors, no CLI execution, no client construction, no credentials", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

    const probeScript = [
      "const targets = [",
      "  './scripts/staging-fixtures/seed.mts',",
      "  './scripts/staging-fixtures/reset.mts',",
      "  './scripts/staging-fixtures/live-deps.mts',",
      "];",
      "for (const t of targets) {",
      "  await import(t);",
      "  console.log('SMOKE_LOADED:' + t);",
      "}",
      "console.log('SMOKE_ALL_LOADED');",
    ].join("\n");

    // Deliberately explicit, not merely "whatever happens to be unset":
    // every fixture-credential variable is removed from the child
    // process's environment before it starts, proving nothing in the
    // import graph reads any staging-fixture secret merely by being
    // imported. Everything else in the ambient environment is kept so
    // the child Node process itself can actually start normally.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const credentialVar of [
      "STAGING_FIXTURE_SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "STAGING_FIXTURE_AUTHOR_PASSWORD",
      "STAGING_FIXTURE_READER_PASSWORD",
    ] as const) {
      delete childEnv[credentialVar];
    }

    let stdout: string;
    try {
      stdout = execFileSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "--eval", probeScript],
        {
          cwd: repoRoot,
          env: childEnv,
          encoding: "utf8",
          // Importing this graph is pure module evaluation (class/function/
          // const declarations only) -- if this ever takes anywhere near
          // this long, something has started doing real I/O at import
          // time, which is itself a regression this test should catch.
          timeout: 30_000,
        },
      );
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string; message: string };
      throw new Error(
        "Real-Node runtime smoke test failed -- the staging fixture scripts' " +
          "import graph does not load cleanly under `node --experimental-strip-types`. " +
          `stdout:\n${execErr.stdout ?? "(none)"}\n\nstderr:\n${execErr.stderr ?? "(none)"}\n\n${execErr.message}`,
      );
    }

    expect(stdout).toContain("SMOKE_LOADED:./scripts/staging-fixtures/seed.mts");
    expect(stdout).toContain("SMOKE_LOADED:./scripts/staging-fixtures/reset.mts");
    expect(stdout).toContain("SMOKE_LOADED:./scripts/staging-fixtures/live-deps.mts");
    expect(stdout).toContain("SMOKE_ALL_LOADED");
  });
});
