// PEN-2: the storage move's audit log (MF5, O-c). One JSON line per event,
// each written and fsynced before the step it records goes ahead.
//
// The file pairs row ids and account-folder keys, so it is sensitive:
//   - it must be outside the repository and outside the shared project
//     folder (/mnt/project-files);
//   - it is created 0600, and an existing file with any group or other
//     permission is refused;
//   - a symlink is refused (O_NOFOLLOW).
// Only its sha256 and line count are ever printed.

import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { AuditEntry, AuditLog } from "./core.mts";

export class AuditLogRefusedError extends Error {}

const FORBIDDEN_ROOTS = ["/mnt/project-files"];

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export type FileAuditLog = AuditLog & { close(): void; sha256(): string; lines(): number; path: string };

export function openAuditLog(path: string, repoRoot: string, now: () => string = () => new Date().toISOString()): FileAuditLog {
  if (!path) throw new AuditLogRefusedError("audit log: --log=<path> is required");
  const full = resolve(path);
  if (inside(resolve(repoRoot), full)) {
    throw new AuditLogRefusedError("audit log: the file must be outside the repository");
  }
  for (const root of FORBIDDEN_ROOTS) {
    if (inside(root, full)) throw new AuditLogRefusedError("audit log: the file must be outside the shared project folder");
  }
  const fd = openSync(full, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const mode = fstatSync(fd).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    closeSync(fd);
    throw new AuditLogRefusedError("audit log: the file must be mode 0600 (no group or other access)");
  }
  let open = true;
  return {
    path: full,
    append(entry: AuditEntry) {
      if (!open) throw new Error("audit log: closed");
      writeSync(fd, `${JSON.stringify({ ts: now(), ...entry })}\n`);
      fsyncSync(fd);
    },
    close() {
      if (open) closeSync(fd);
      open = false;
    },
    sha256() {
      return createHash("sha256").update(readFileSync(full)).digest("hex");
    },
    lines() {
      return readFileSync(full, "utf8").split("\n").filter(Boolean).length;
    },
  };
}
