import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// PAID-MODE-1: two independent proofs that the paid-mode module never
// reaches a payment provider -- one at runtime, one over the static
// module graph. Neither is a single-file regex: the existing precedents
// (payouts/run/route.test.ts, finance/page.test.ts) can only see depth
// one, and a provider reached through an intermediate module is exactly
// the failure worth catching.
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_MODULES = [
  "stripe",
  "@stripe/stripe-js",
  "@/lib/stripe",
  "@/lib/pok",
  "@/lib/pok-checkout",
  "@/lib/pok-repository",
  "@/lib/connect-account",
  "@/lib/checkout-regime",
];

describe("paid-readiness never loads a payment provider at runtime", () => {
  it("imports cleanly in a registry where every provider module throws on load", async () => {
    vi.resetModules();
    for (const specifier of FORBIDDEN_MODULES) {
      vi.doMock(specifier, () => {
        throw new Error(`paid-readiness transitively loaded ${specifier}`);
      });
    }

    try {
      const paidReadiness = await import("@/lib/paid-readiness");
      // Exercised, not merely imported: a provider pulled in lazily
      // inside a resolver would still fail this test.
      expect(paidReadiness.resolvePaidPublishingMode({}).allowed).toBe(false);
      expect(paidReadiness.resolvePaidCheckoutMode({}).allowed).toBe(false);
    } finally {
      for (const specifier of FORBIDDEN_MODULES) vi.doUnmock(specifier);
      vi.resetModules();
    }
  });

  // Control: the specifiers above really do intercept, so the test
  // above passing means something. Without this, a typo in one
  // specifier would make the whole proof vacuous -- a module that is
  // never mocked also never throws.
  //
  // A recording factory rather than a throwing one, purely so the
  // assertion can name the module that was loaded: Vitest replaces a
  // throwing factory's own error with its generic mocking-failed
  // message, which would prove only that SOMETHING failed.
  it("the same specifiers really do intercept a module that imports a provider", async () => {
    vi.resetModules();
    const loaded: string[] = [];
    vi.doMock("@/lib/pok", async (importOriginal) => {
      loaded.push("@/lib/pok");
      return await importOriginal<typeof import("@/lib/pok")>();
    });
    try {
      await import("@/lib/pok-checkout");
      expect(loaded).toEqual(["@/lib/pok"]);
    } finally {
      vi.doUnmock("@/lib/pok");
      vi.resetModules();
    }
  });
});

// A second net over the static graph, because `import type` specifiers
// are erased before runtime and so are invisible to the proof above.
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC_DIR, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null; // an external package, handled separately
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // not this candidate
    }
  }
  return null;
}

function collectImportGraph(entry: string): { files: Set<string>; externals: Set<string> } {
  const files = new Set<string>();
  const externals = new Set<string>();
  const queue = [entry];
  // Matches `from "x"`, bare `import "x"`, and dynamic `import("x")`.
  const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1];
      const resolved = resolveSpecifier(specifier, file);
      if (resolved === null) {
        externals.add(specifier);
        continue;
      }
      if (!files.has(resolved)) queue.push(resolved);
    }
  }
  return { files, externals };
}

describe("paid-readiness static module graph", () => {
  const entry = path.join(SRC_DIR, "lib/paid-readiness.ts");
  const { files, externals } = collectImportGraph(entry);

  it("is exactly two first-party files", () => {
    expect([...files].map((f) => path.relative(SRC_DIR, f)).sort()).toEqual([
      "lib/paid-readiness.ts",
      "lib/protected-staging.ts",
    ]);
  });

  it("depends on no external package but server-only", () => {
    expect([...externals].sort()).toEqual(["server-only"]);
  });

  it("names no payment-provider module anywhere in its closure, type imports included", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
        expect(FORBIDDEN_MODULES).not.toContain(match[1]);
      }
    }
  });

  // The read-set proof in paid-readiness.test.ts is the behavioural
  // guarantee; this is the same claim asserted over the source of every
  // file in the closure, so a provider variable cannot even be named.
  it("reads no payment-provider environment variable anywhere in its closure", () => {
    const forbiddenVariables = [
      "POK_ENVIRONMENT",
      "NEW_CHECKOUT_REGIME",
      "LEDGER_PAYMENT_PROVIDER",
      "POK_MERCHANT_ID",
      "POK_KEY_ID",
      "POK_KEY_SECRET",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_CONNECT_WEBHOOK_SECRET",
    ];
    for (const file of files) {
      // Comments are stripped first: both modules deliberately DISCUSS
      // these variables in prose, and saying "never reads POK_ENVIRONMENT"
      // must not be what fails this test.
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const variable of forbiddenVariables) {
        expect(code).not.toContain(variable);
      }
    }
  });
});
