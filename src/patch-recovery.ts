import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { replaceFile } from "./apply-patch.js";
import { fileRevision } from "./file-revision.js";
import { logEvent } from "./logger.js";
import type { ServerConfig } from "./config.js";
import { PatchTransactionStore } from "./patch-transaction-store.js";
import type {
  PatchFileState,
  PatchTransactionFile,
  PatchTransactionJournal,
  PatchTransactionManifest,
  PatchTransactionRecord,
} from "./patch-transaction-types.js";
import { ToolOperationError } from "./tool-errors.js";

interface ResolvedFile {
  entry: PatchTransactionFile;
  target: string;
  final?: string;
  recovery?: string;
  replacementBackup?: string;
  recoveryReplacementBackup?: string;
  backups: string[];
}

export interface PatchRecoveryOutcome {
  id: string;
  root: string;
  outcome: "restored" | "preparing_cleaned" | "committed_cleaned" | "recovery_required" | "cleanup_failed";
  diagnostic?: string;
}

export class PatchRecoveryManager implements PatchTransactionJournal {
  private readonly store: PatchTransactionStore;

  constructor(stateDir: string) {
    this.store = new PatchTransactionStore(stateDir);
  }

  assertRootWritable(root: string): void {
    if (!this.store.hasRecoveryRequiredRoot(root)) return;
    throw new ToolOperationError({
      code: "PATCH_RECOVERY_REQUIRED",
      category: "recovery",
      message: `Patch recovery requires local inspection for workspace root ${root}. Run devspace recovery list.`,
      retryable: false,
      path: root,
    });
  }

  createPreparing(manifest: PatchTransactionManifest): void { this.store.createPreparing(manifest); }
  markPrepared(id: string): void { this.store.markPrepared(id); }
  markCommitting(id: string): void { this.store.markCommitting(id); }
  markCommitted(id: string): void { this.store.markCommitted(id); }
  markRecoveryRequired(id: string, diagnostic: string): void { this.store.markRecoveryRequired(id, diagnostic); }
  delete(id: string): void { this.store.delete(id); }

  list(): PatchTransactionRecord[] {
    return this.store.list();
  }

  show(id: string): PatchTransactionRecord | undefined {
    return this.store.get(id);
  }

  protectedRoots(): Set<string> {
    return new Set(
      this.store.list()
        .filter((record) => record.state !== "committed")
        .map((record) => record.root),
    );
  }

  async acceptCurrent(id: string): Promise<void> {
    const record = this.store.get(id);
    if (!record) throw new Error(`Unknown patch transaction: ${id}`);
    if (record.state !== "recovery_required" && record.state !== "committed") {
      throw new Error(
        `Patch transaction ${id} is neither recovery_required nor committed cleanup debt`,
      );
    }
    try {
      const files = await resolveRecordFiles(record);
      await cleanupRecognizedOwnedFiles(files);
    } catch {
      // Explicit operator resolution accepts the current project state. If the
      // manifest/root cannot be trusted enough for safe cleanup, leave any
      // unknown artifacts in place rather than touching project paths.
    }
    this.store.delete(id);
  }

  async reconcileStartup(options: {
    /** Test-only crash boundary; production does not supply this hook. */
    afterRecoveryMilestone?: (name: string, index?: number) => Promise<void> | void;
  } = {}): Promise<PatchRecoveryOutcome[]> {
    const outcomes: PatchRecoveryOutcome[] = [];
    for (const record of this.store.list()) {
      if (record.state === "recovery_required") {
        outcomes.push({ id: record.id, root: record.root, outcome: "recovery_required", diagnostic: record.diagnostic });
        continue;
      }
      try {
        const files = await resolveRecordFiles(record);
        if (record.state === "preparing") {
          await verifyPreparingArtifacts(files);
          await cleanupOwnedFiles(record.root, files);
          this.store.delete(record.id);
          outcomes.push({ id: record.id, root: record.root, outcome: "preparing_cleaned" });
          continue;
        }
        if (record.state === "committed") {
          await verifyCleanupArtifacts(files);
          await cleanupOwnedFiles(record.root, files);
          this.store.delete(record.id);
          outcomes.push({ id: record.id, root: record.root, outcome: "committed_cleaned" });
          continue;
        }
        if (record.state === "prepared") {
          await verifyPreparedTargets(record, files);
          await verifyPreparedArtifacts(files);
          await cleanupOwnedFiles(record.root, files);
          this.store.delete(record.id);
          outcomes.push({ id: record.id, root: record.root, outcome: "restored" });
          continue;
        }
        await recoverInterrupted(record, files, options.afterRecoveryMilestone);
        await cleanupOwnedFiles(record.root, files);
        this.store.delete(record.id);
        outcomes.push({ id: record.id, root: record.root, outcome: "restored" });
      } catch (error) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        if (record.state === "committed") {
          outcomes.push({ id: record.id, root: record.root, outcome: "cleanup_failed", diagnostic });
          continue;
        }
        this.store.markRecoveryRequired(record.id, diagnostic);
        outcomes.push({ id: record.id, root: record.root, outcome: "recovery_required", diagnostic });
      }
    }
    return outcomes;
  }

  close(): void {
    this.store.close();
  }
}

export async function runPatchStartupRecovery(config: ServerConfig): Promise<PatchRecoveryOutcome[]> {
  const manager = new PatchRecoveryManager(config.stateDir);
  try {
    const outcomes = await manager.reconcileStartup();
    for (const outcome of outcomes) {
      const level = outcome.outcome === "recovery_required" || outcome.outcome === "cleanup_failed"
        ? "warn"
        : "info";
      logEvent(config.logging, level, "patch_startup_recovery", {
        transactionId: outcome.id,
        workspaceRoot: outcome.root,
        outcome: outcome.outcome,
        diagnostic: outcome.diagnostic,
      });
    }
    return outcomes;
  } finally {
    manager.close();
  }
}

async function resolveRecordFiles(record: PatchTransactionRecord): Promise<ResolvedFile[]> {
  if (record.manifestError) throw new Error(`Corrupt patch manifest: ${record.manifestError}`);
  if (!isAbsolute(record.root) || await realpath(record.root) !== record.root) {
    throw new Error(`Patch workspace root is not canonical: ${record.root}`);
  }
  const seen = new Set<string>();
  const resolved: ResolvedFile[] = [];
  for (const [index, entry] of record.files.entries()) {
    const target = await confinedPath(record.root, entry.path);
    claimRecoveryPath(seen, target, entry.path);
    const prefix = `${entry.path}.devspace-patch-${record.id}-${index}`;
    const expectedFinal = entry.published.kind === "present" ? `${prefix}-final` : undefined;
    const expectedRecovery = entry.original.kind === "present" ? `${prefix}-original` : undefined;
    if (entry.finalPath !== expectedFinal || entry.recoveryPath !== expectedRecovery
      || entry.replacementBackupPath !== (expectedFinal ? `${expectedFinal}.original` : undefined)
      || entry.recoveryReplacementBackupPath !== (expectedRecovery ? `${expectedRecovery}.original` : undefined)) {
      throw new Error(`Invalid transaction-owned file manifest for ${entry.path}`);
    }
    const final = entry.finalPath ? await confinedPath(record.root, entry.finalPath) : undefined;
    const recovery = entry.recoveryPath ? await confinedPath(record.root, entry.recoveryPath) : undefined;
    const replacementBackup = entry.replacementBackupPath
      ? await confinedPath(record.root, entry.replacementBackupPath)
      : undefined;
    const recoveryReplacementBackup = entry.recoveryReplacementBackupPath
      ? await confinedPath(record.root, entry.recoveryReplacementBackupPath)
      : undefined;
    for (const owned of [final, recovery, replacementBackup, recoveryReplacementBackup]) {
      if (!owned) continue;
      if (dirname(owned) !== dirname(target)) {
        throw new Error(`Transaction-owned file is not beside target: ${entry.path}`);
      }
      claimRecoveryPath(seen, owned, entry.path);
    }
    const backups = [replacementBackup, recoveryReplacementBackup]
      .filter((path): path is string => path !== undefined);
    resolved.push({
      entry,
      target,
      final,
      recovery,
      replacementBackup,
      recoveryReplacementBackup,
      backups,
    });
  }
  return resolved;
}

function claimRecoveryPath(seen: Set<string>, path: string, displayPath: string): void {
  if (seen.has(path)) throw new Error(`Duplicate/colliding patch recovery path: ${displayPath}`);
  seen.add(path);
}

async function confinedPath(root: string, input: string): Promise<string> {
  if (!input || input.includes("\0") || isAbsolute(input)) throw new Error(`Invalid patch recovery path: ${input}`);
  const absolute = resolve(root, input);
  const relationship = relative(root, absolute);
  if (!relationship || relationship === ".." || relationship.startsWith(`..${sep}`)
    || isAbsolute(relationship)) throw new Error(`Patch recovery path escapes root: ${input}`);
  let parent = dirname(absolute);
  for (;;) {
    try {
      const canonical = await realpath(parent);
      const rel = relative(root, canonical);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Patch recovery path resolves outside root: ${input}`);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
  return absolute;
}

async function recoverInterrupted(
  record: PatchTransactionRecord,
  files: ResolvedFile[],
  afterRecoveryMilestone?: (name: string, index?: number) => Promise<void> | void,
): Promise<void> {
  const published: ResolvedFile[] = [];
  const ambiguous: string[] = [];
  for (const file of files) {
    const current = await filesystemState(file.target);
    const isOriginal = sameState(current, file.entry.original);
    const isPublished = sameState(current, file.entry.published);
    const knownReplacementGap = !isOriginal && !isPublished
      ? await isKnownWindowsReplacementGap(file, current)
      : false;
    if (!isOriginal && !isPublished && !knownReplacementGap) {
      ambiguous.push(file.entry.path);
    } else if (!isOriginal) {
      published.push(file);
    }
    if (file.recovery) {
      const recovery = await filesystemState(file.recovery);
      if (!sameState(recovery, file.entry.original)
        && !(record.state === "committing" && isOriginal && recovery.kind === "absent")) {
        ambiguous.push(`${file.entry.path} (missing/corrupt recovery file)`);
      }
    }
    if (file.final) {
      const prepared = await filesystemState(file.final);
      if (prepared.kind === "present" && !sameState(prepared, file.entry.published)) {
        ambiguous.push(`${file.entry.path} (corrupt prepared file)`);
      } else if (record.state === "prepared" && prepared.kind === "absent") {
        ambiguous.push(`${file.entry.path} (missing prepared file)`);
      }
    }
    if (file.replacementBackup) {
      const backup = await filesystemState(file.replacementBackup);
      if (backup.kind === "present" && !sameState(backup, file.entry.original)) {
        ambiguous.push(`${file.entry.path} (corrupt publication backup)`);
      }
    }
    if (file.recoveryReplacementBackup) {
      const backup = await filesystemState(file.recoveryReplacementBackup);
      if (backup.kind === "present" && !sameState(backup, file.entry.published)) {
        ambiguous.push(`${file.entry.path} (corrupt rollback backup)`);
      }
    }
  }
  if (ambiguous.length > 0) throw new Error(`Ambiguous patch paths: ${[...new Set(ambiguous)].join(", ")}`);

  for (const [index, file] of published.reverse().entries()) {
    await confinedPath(record.root, file.entry.path);
    const current = await filesystemState(file.target);
    if (!sameState(current, file.entry.published)
      && !await isKnownWindowsReplacementGap(file, current)) {
      throw new Error(`Patch path changed during recovery: ${file.entry.path}`);
    }
    if (file.entry.original.kind === "absent") {
      await rm(file.target, { force: true });
    } else {
      if (!file.recovery || !sameState(await filesystemState(file.recovery), file.entry.original)) {
        throw new Error(`Recovery file changed during recovery: ${file.entry.path}`);
      }
      await replaceFile(file.recovery, file.target, await exists(file.target));
    }
    await afterRecoveryMilestone?.("restored", index);
  }
  for (const file of files) {
    if (!sameState(await filesystemState(file.target), file.entry.original)) {
      throw new Error(`Patch original could not be verified: ${file.entry.path}`);
    }
  }
}

async function verifyPreparedTargets(
  record: PatchTransactionRecord,
  files: ResolvedFile[],
): Promise<void> {
  const ambiguous: string[] = [];
  for (const file of files) {
    if (!sameState(await filesystemState(file.target), file.entry.original)) {
      ambiguous.push(file.entry.path);
    }
  }
  if (ambiguous.length > 0) {
    throw new Error(
      `Prepared patch changed project paths before commit: ${[...new Set(ambiguous)].join(", ")}`,
    );
  }
}

async function verifyPreparingArtifacts(files: ResolvedFile[]): Promise<void> {
  const ambiguous: string[] = [];
  for (const file of files) {
    for (const [path, label] of [
      [file.replacementBackup, "publication backup"],
      [file.recoveryReplacementBackup, "rollback backup"],
    ] as const) {
      if (path && (await filesystemState(path)).kind !== "absent") {
        ambiguous.push(`${file.entry.path} (unexpected ${label})`);
      }
    }
  }
  if (ambiguous.length > 0) {
    throw new Error(`Ambiguous patch artifacts: ${ambiguous.join(", ")}`);
  }
}

async function verifyPreparedArtifacts(files: ResolvedFile[]): Promise<void> {
  const ambiguous: string[] = [];
  for (const file of files) {
    await collectUnexpectedArtifact(
      ambiguous,
      file.final,
      file.entry.published,
      file.entry.path,
      "prepared file",
    );
    await collectUnexpectedArtifact(
      ambiguous,
      file.recovery,
      file.entry.original,
      file.entry.path,
      "recovery file",
    );
    for (const [path, label] of [
      [file.replacementBackup, "publication backup"],
      [file.recoveryReplacementBackup, "rollback backup"],
    ] as const) {
      if (path && (await filesystemState(path)).kind !== "absent") {
        ambiguous.push(`${file.entry.path} (unexpected ${label})`);
      }
    }
  }
  if (ambiguous.length > 0) {
    throw new Error(`Ambiguous patch artifacts: ${ambiguous.join(", ")}`);
  }
}

async function verifyCleanupArtifacts(files: ResolvedFile[]): Promise<void> {
  const ambiguous: string[] = [];
  for (const file of files) {
    await collectUnexpectedArtifact(
      ambiguous,
      file.final,
      file.entry.published,
      file.entry.path,
      "prepared file",
    );
    await collectUnexpectedArtifact(
      ambiguous,
      file.recovery,
      file.entry.original,
      file.entry.path,
      "recovery file",
    );
    await collectUnexpectedArtifact(
      ambiguous,
      file.replacementBackup,
      file.entry.original,
      file.entry.path,
      "publication backup",
    );
    await collectUnexpectedArtifact(
      ambiguous,
      file.recoveryReplacementBackup,
      file.entry.published,
      file.entry.path,
      "rollback backup",
    );
  }
  if (ambiguous.length > 0) {
    throw new Error(`Ambiguous patch artifacts: ${ambiguous.join(", ")}`);
  }
}

async function collectUnexpectedArtifact(
  ambiguous: string[],
  path: string | undefined,
  expected: PatchFileState,
  displayPath: string,
  label: string,
): Promise<void> {
  if (!path) return;
  const current = await filesystemState(path);
  if (current.kind !== "absent" && !sameState(current, expected)) {
    ambiguous.push(`${displayPath} (corrupt ${label})`);
  }
}

async function isKnownWindowsReplacementGap(
  file: ResolvedFile,
  current: PatchFileState,
): Promise<boolean> {
  if (current.kind !== "absent"
    || file.entry.original.kind !== "present"
    || file.entry.published.kind !== "present"
    || !file.recovery) {
    return false;
  }
  if (!sameState(await filesystemState(file.recovery), file.entry.original)) return false;

  const publicationBackup = file.replacementBackup
    ? await filesystemState(file.replacementBackup)
    : { kind: "absent" } as const;
  const rollbackBackup = file.recoveryReplacementBackup
    ? await filesystemState(file.recoveryReplacementBackup)
    : { kind: "absent" } as const;
  return sameState(publicationBackup, file.entry.original)
    || sameState(rollbackBackup, file.entry.published);
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function cleanupOwnedFiles(root: string, files: ResolvedFile[]): Promise<void> {
  for (const file of files) {
    for (const path of [file.final, file.recovery, ...file.backups]) {
      if (path) {
        await confinedPath(root, relative(root, path));
        await rm(path, { force: true });
      }
    }
  }
}

async function cleanupRecognizedOwnedFiles(files: ResolvedFile[]): Promise<void> {
  for (const file of files) {
    for (const [path, expected] of [
      [file.final, file.entry.published],
      [file.recovery, file.entry.original],
      [file.replacementBackup, file.entry.original],
      [file.recoveryReplacementBackup, file.entry.published],
    ] as const) {
      if (!path) continue;
      const current = await filesystemState(path);
      if (current.kind !== "absent" && sameState(current, expected)) {
        await rm(path, { force: true });
      }
    }
  }
}

async function filesystemState(path: string): Promise<PatchFileState> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (!metadata.isFile()) throw new Error(`Patch recovery path is not a regular file: ${path}`);
  return {
    kind: "present",
    revision: fileRevision(await readFile(path)),
    mode: metadata.mode,
  };
}

function sameState(actual: PatchFileState, expected: PatchFileState): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === "absent" || expected.kind === "absent") return true;
  return actual.revision === expected.revision
    && (expected.mode === undefined || actual.mode === expected.mode);
}
