// PEN-2 rollout step 3 (and step 5): move cover and pen-name photo files
// off account-id keys.
//
//   node --experimental-strip-types --env-file=.env.<env>.local \
//     scripts/pen-names-storage/move.mts <mode> --project-ref=<ref> [options]
//
// Modes:
//   plan        (default) read-only; prints counts only.
//   copy        copies each old-shape file to a fresh random key, checks
//               size and sha256, repoints the row with a compare-and-set;
//               needs --log=<path> (outside the repo, 0600) and a typed
//               confirmation. Idempotent and resumable.
//   verify      read-only; every row is in the new shape and its object
//               exists. Owner is checked in SQL (contract C0), not here.
//   delete-old  step 5: removes every object in covers and avatars that is
//               not in a new shape and that no row names; clears profile
//               photos it removed. Needs --contract-applied, a passing
//               verify and a typed confirmation.
//               Its run plan must say that deleted public objects can
//               stay cached at the CDN for the bucket's cache-control
//               period (O16).
//
// Env: PEN_NAMES_STORAGE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. The
// key is never printed. Only staging or production may be targeted, and
// only the one --project-ref names. It runs under the DB flow: a run
// plan, Renato's typed approval, then the operator runs it.
//
// Never run it against a real project from a build or a test.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteOldRefusedError, runCopy, runDeleteOld, runPlan, runVerify, type Deps } from "./core.mts";
import { openAuditLog, type FileAuditLog } from "./audit-log.mts";

export type Mode = "plan" | "copy" | "verify" | "delete-old";
export type CliOptions = { mode: Mode; projectRef?: string; log?: string; contractApplied: boolean };

export class UsageError extends Error {}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mode: "plan", contractApplied: false };
  let modeSeen = false;
  for (const arg of argv) {
    if (arg === "--contract-applied") options.contractApplied = true;
    else if (arg.startsWith("--project-ref=")) options.projectRef = arg.slice("--project-ref=".length);
    else if (arg.startsWith("--log=")) options.log = arg.slice("--log=".length);
    else if (!arg.startsWith("--") && !modeSeen) {
      if (arg !== "plan" && arg !== "copy" && arg !== "verify" && arg !== "delete-old") {
        throw new UsageError("mode must be plan, copy, verify or delete-old");
      }
      options.mode = arg;
      modeSeen = true;
    } else throw new UsageError("unknown argument");
  }
  if (options.mode === "copy" && !options.log) throw new UsageError("copy needs --log=<path>");
  return options;
}

export const confirmationPhrase = (ref: string, mode: Mode) => `${ref} ${mode}`;

export type CliDeps = Deps & {
  ref: string;
  repoRoot: string;
  ask: (prompt: string) => Promise<string>;
};

// Returns the process exit code. Counts and the log's sha256 only.
export async function runCli(options: CliOptions, deps: CliDeps): Promise<number> {
  if (options.mode === "plan") {
    const counts = await runPlan(deps);
    return counts.storage_errors > 0 ? 1 : 0;
  }
  if (options.mode === "verify") {
    return (await runVerify(deps)).ok ? 0 : 1;
  }

  const phrase = confirmationPhrase(deps.ref, options.mode);
  const typed = (await deps.ask(`Type "${phrase}" to continue: `)).trim();
  if (typed !== phrase) {
    deps.out("confirmation did not match; nothing was changed");
    return 2;
  }

  let log: FileAuditLog | undefined;
  try {
    if (options.log) log = openAuditLog(options.log, deps.repoRoot);
    if (options.mode === "copy") {
      const counts = await runCopy(deps, log as FileAuditLog);
      return counts.errors > 0 ? 1 : 0;
    }
    try {
      const counts = await runDeleteOld(deps, { contractApplied: options.contractApplied }, log);
      return counts.errors > 0 ? 1 : 0;
    } catch (error) {
      if (error instanceof DeleteOldRefusedError) {
        deps.out(error.message);
        return 2;
      }
      throw error;
    }
  } finally {
    if (log) {
      log.close();
      deps.out(`audit log: lines=${log.lines()} sha256=${log.sha256()}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "bad arguments");
    process.exit(64);
  }
  const { buildServiceClient, liveDb, liveStorage } = await import("./live.mts");
  const { client, ref } = buildServiceClient(options.projectRef);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const code = await runCli(options, {
      ref,
      repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
      db: liveDb(client),
      storage: liveStorage(client),
      out: (line) => console.log(line),
      ask: (prompt) => rl.question(prompt),
    });
    process.exitCode = code;
  } finally {
    rl.close();
  }
}
