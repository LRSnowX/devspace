import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import * as z from "zod/v4";

const identifier = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value && !value.includes("\0"));
const pidSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const kindSchema = z.enum([
  "shell_process",
  "apply_patch",
  "write",
  "edit",
  "subagent_turn",
]);
const ownershipSchema = z
  .object({
    schema_version: z.literal(1),
    canonical_root: z.string().min(1),
    ownership_id: z.string().uuid(),
    owner_workspace_id: identifier,
    acquired_at: z.iso.datetime(),
    active_mutations: z.array(
      z
        .object({
          activity_id: z.string().uuid(),
          kind: kindSchema,
          started_at: z.iso.datetime(),
          executor_processes: z.array(pidSchema),
          executor_processes_complete: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((record, context) => {
    const activities = new Set<string>();
    for (const mutation of record.active_mutations) {
      if (
        activities.has(mutation.activity_id) ||
        new Set(mutation.executor_processes).size !==
          mutation.executor_processes.length ||
        (mutation.executor_processes_complete &&
          mutation.executor_processes.length === 0)
      ) {
        context.addIssue({
          code: "custom",
          message: "Invalid or duplicate mutation identity/executor evidence",
        });
      }
      activities.add(mutation.activity_id);
    }
  });
const mutexSchema = z
  .object({
    schema_version: z.literal(1),
    canonical_root: z.string(),
    nonce: z.string().uuid(),
    pid: pidSchema,
    role: z.enum(["transition", "recovery"]),
    staged_file: z.string(),
    backup_file: z.string(),
  })
  .strict();

const retentionSchema = z
  .object({
    schema_version: z.literal(1),
    canonical_root: z.string().min(1),
    guard_id: z.string().uuid(),
    kind: z.enum(["managed_worktree", "workspace_metadata"]),
    started_at: z.iso.datetime(),
    executor_processes: z.array(pidSchema),
    executor_processes_complete: z.boolean(),
    root_identity: z
      .object({ dev: z.string(), ino: z.string() })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (record) =>
      new Set(record.executor_processes).size ===
        record.executor_processes.length &&
      (!record.executor_processes_complete ||
        record.executor_processes.length > 0),
  );

export type DestructiveRetentionRecord = z.infer<typeof retentionSchema>;

export type WriteOwnershipRecord = z.infer<typeof ownershipSchema>;
export type MutationKind = z.infer<typeof kindSchema>;
export type ProcessLiveness = "live" | "dead" | "unknown";
export type WriteOwnershipErrorCode =
  | "WRITE_OWNERSHIP_REQUIRED"
  | "WRITE_OWNERSHIP_CONFLICT"
  | "WRITE_OWNERSHIP_BUSY"
  | "WRITE_OWNERSHIP_RECOVERY_REQUIRED";

/** Core errors only. Later adapters translate these into their own envelopes. */
export class WriteOwnershipError extends Error {
  constructor(
    readonly code: WriteOwnershipErrorCode,
    message: string,
    readonly record?: WriteOwnershipRecord,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WriteOwnershipError";
  }
}

export interface WriteOwnershipStoreOptions {
  processLiveness?: (pid: number) => ProcessLiveness;
  /** Test seam before atomic publication (after staging for replacements). */
  beforePublish?: () => void;
  /** Test seam after the Windows destination has moved to its recovery backup. */
  afterReplacementBackup?: () => void;
  /** Test seam for exercising the Windows replacement algorithm cross-platform. */
  platform?: NodeJS.Platform;
}

interface Snapshot {
  content: string;
  dev: number;
  ino: number;
}
interface Mutex {
  path: string;
  record: z.infer<typeof mutexSchema>;
  snapshot: Snapshot;
}
interface Transition<T> {
  /** Omitted: unchanged. null: publish unowned. */
  next?: WriteOwnershipRecord | null;
  result: T;
}

export function writeOwnershipPaths(stateDir: string, canonicalRoot: string) {
  validateRoot(canonicalRoot);
  const hash = createHash("sha256").update(canonicalRoot).digest("hex");
  const directory = join(resolve(stateDir), "write-ownership");
  return {
    directory,
    state: join(directory, `${hash}.json`),
    retention: join(directory, `${hash}.retention.json`),
    mutex: join(directory, `${hash}.mutex`),
    recoveryGate: join(directory, `${hash}.recovery`),
    hash,
  };
}

/** Short, nonwaiting transitions. The filesystem mutex reserves no write
 * authority; the atomically replaced JSON record does. No age-based reclamation. */
export class WriteOwnershipStore {
  private readonly retentionSnapshots = new WeakMap<DestructiveRetentionRecord, Snapshot>();
  private readonly stateDir: string;
  private readonly platform: NodeJS.Platform;
  readonly processLiveness: (pid: number) => ProcessLiveness;

  constructor(
    stateDir: string,
    private readonly options: WriteOwnershipStoreOptions = {},
  ) {
    ensureSecureDirectory(resolve(stateDir));
    this.stateDir = realpathSync(stateDir);
    ensureSecureDirectory(join(this.stateDir, "write-ownership"));
    this.platform = options.platform ?? process.platform;
    this.processLiveness = (pid) => {
      try {
        return (options.processLiveness ?? probeProcess)(pid);
      } catch {
        return "unknown";
      }
    };
  }

  inspect(root: string): WriteOwnershipRecord | undefined {
    const paths = this.paths(root);
    this.checkRecoveryGate(root);
    const mutex = this.readMutex(paths.mutex, root, "transition");
    if (mutex && this.processLiveness(mutex.record.pid) !== "live") {
      throw recoveryError(
        "Unfinished ownership transition requires explicit recovery.",
      );
    }
    const guard = this.readRetention(root);
    if (guard && this.retentionLiveness(guard) !== "live")
      throw recoveryError("Unfinished destructive retention requires explicit recovery.");
    const record = this.readState(paths.state, root).record;
    if (guard && record) throw recoveryError("Ownership and destructive retention coexist unexpectedly.");
    return record;
  }

  readRetention(root: string): DestructiveRetentionRecord | undefined {
    const snapshot = readSnapshot(this.paths(root).retention);
    if (!snapshot) return undefined;
    try {
      const guard = retentionSchema.parse(JSON.parse(snapshot.content));
      if (guard.canonical_root !== root)
        throw new Error("Retention root mismatch");
      this.retentionSnapshots.set(guard, snapshot);
      return guard;
    } catch (error) {
      throw recoveryError("Undecodable or mismatched retention guard.", error);
    }
  }

  retentionLiveness(guard: DestructiveRetentionRecord): ProcessLiveness {
    const states = guard.executor_processes.map((pid) =>
      this.processLiveness(pid),
    );
    if (states.includes("live")) return "live";
    if (
      !guard.executor_processes_complete ||
      states.length === 0 ||
      states.includes("unknown")
    )
      return "unknown";
    return "dead";
  }

  /** Called only within transition/recovery's short root mutex. */
  replaceRetention(
    root: string,
    next: DestructiveRetentionRecord | undefined,
    expected?: DestructiveRetentionRecord,
  ): void {
    const paths = this.paths(root);
    const before = expected ? this.retentionSnapshots.get(expected) : undefined;
    if (expected && !before)
      throw recoveryError("Retention guard was not inspected by this store.");
    assertExactFile(paths.retention, before);
    const mutex = this.readMutex(paths.mutex, root, "transition");
    if (!mutex || mutex.record.pid !== process.pid)
      throw recoveryError("Retention transition has no root mutex.");
    const staged = join(paths.directory, mutex.record.staged_file);
    try {
      if (next) {
        const decoded = retentionSchema.parse(next);
        if (decoded.canonical_root !== root)
          throw recoveryError("Retention root mismatch.");
        writeFileSync(staged, `${JSON.stringify(decoded)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        this.options.beforePublish?.();
        assertExactFile(paths.retention, before);
        assertExactFile(mutex.path, mutex.snapshot);
        // POSIX atomic replacement; on Windows a failed replacement preserves
        // the guard. Do not retire it before a successful update.
        renameSync(staged, paths.retention);
      } else if (before) {
        this.options.beforePublish?.();
        assertExactFile(paths.retention, before);
        assertExactFile(mutex.path, mutex.snapshot);
        renameSync(paths.retention, staged);
        unlinkSync(staged);
      }
    } finally {
      removeIfPresent(staged);
    }
  }

  /** Operator-only diagnostics: malformed entries remain visible, never reaped. */
  list() {
    const directory = join(this.stateDir, "write-ownership");
    ensureSecureDirectory(directory);
    const roots = new Set<string>();
    const errors: Array<{ path: string; error: string }> = [];
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      try {
        const raw = JSON.parse(readSnapshot(path)!.content) as {
          canonical_root?: unknown;
        };
        if (typeof raw.canonical_root !== "string")
          throw new Error("Missing canonical root");
        const paths = this.paths(raw.canonical_root);
        if (
          ![
            paths.state,
            paths.retention,
            paths.mutex,
            paths.recoveryGate,
          ].includes(path)
        )
          throw new Error("Unexpected recovery artifact or root hash mismatch");
        roots.add(raw.canonical_root);
      } catch (error) {
        errors.push({
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { roots: [...roots].sort(), errors };
  }

  transition<T>(
    root: string,
    operation: (record: WriteOwnershipRecord | undefined) => Transition<T>,
  ): T {
    return this.withMutex(root, false, (record) => {
      const guard = this.readRetention(root);
      if (guard && record)
        throw recoveryError(
          "Ownership and destructive retention coexist unexpectedly.",
        );
      if (guard) {
        if (this.retentionLiveness(guard) === "live")
          throw busyError("Destructive retention is in progress.");
        throw recoveryError(
          "Destructive retention requires explicit recovery.",
        );
      }
      return operation(record);
    });
  }

  retentionTransition<T>(
    root: string,
    operation: (record: WriteOwnershipRecord | undefined) => Transition<T>,
  ): T {
    return this.withMutex(root, false, (record) => {
      if (record && this.readRetention(root))
        throw recoveryError(
          "Ownership and destructive retention coexist unexpectedly.",
        );
      return operation(record);
    });
  }

  recover<T>(
    root: string,
    operation: (record: WriteOwnershipRecord | undefined) => Transition<T>,
  ): T {
    const paths = this.paths(root);
    // A recovery gate serializes stale-mutex inspection/removal. Normal entrants
    // check it both before and after publishing their mutex. A late contender's
    // replacement is never unlinked by this recovery attempt.
    const gate = this.publishMutex(paths.recoveryGate, root, "recovery");
    try {
      const stale = this.readMutex(paths.mutex, root, "transition");
      if (stale) {
        const liveness = this.processLiveness(stale.record.pid);
        if (liveness === "live")
          throw busyError("An ownership transition is still running.");
        if (liveness !== "dead")
          throw recoveryError(
            "Ownership transition executor liveness is ambiguous.",
          );
        this.reconcileInterruptedReplacement(root, paths, stale);
        assertExactFile(stale.path, stale.snapshot);
        const retired = `${stale.path}.${gate.record.nonce}.retired`;
        renameSync(stale.path, retired);
        try {
          // Verify the file moved really is the record inspected above.
          assertExactFile(retired, stale.snapshot);
          removeIfPresent(join(paths.directory, stale.record.staged_file));
          unlinkSync(retired);
        } catch (error) {
          // Keep the transition path fail-closed if retirement/cleanup could not
          // be verified. link never overwrites a contender's replacement.
          try {
            linkSync(retired, stale.path);
            unlinkSync(retired);
          } catch (restoreError) {
            if (!isCode(restoreError, "EEXIST")) {
              throw recoveryError(
                `Cannot restore interrupted mutex for inspection: ${retired}`,
                restoreError,
              );
            }
          }
          throw recoveryError(
            `Cannot clean interrupted transition: ${retired}`,
            error,
          );
        }
      }
      return this.withMutex(root, true, operation);
    } finally {
      this.releaseMutex(gate);
    }
  }

  private paths(root: string) {
    ensureSecureDirectory(this.stateDir);
    const paths = writeOwnershipPaths(this.stateDir, root);
    ensureSecureDirectory(paths.directory);
    return paths;
  }

  private checkRecoveryGate(root: string): void {
    const paths = writeOwnershipPaths(this.stateDir, root);
    const gate = this.readMutex(paths.recoveryGate, root, "recovery");
    if (!gate) return;
    if (this.processLiveness(gate.record.pid) === "live")
      throw busyError("Ownership recovery is in progress.");
    // An interrupted recovery gate is deliberately not recursively reaped.
    // Its unknown critical-section boundary requires local manual inspection.
    throw recoveryError(
      "Unfinished ownership recovery requires manual inspection.",
    );
  }

  private withMutex<T>(
    root: string,
    recovering: boolean,
    operation: (record: WriteOwnershipRecord | undefined) => Transition<T>,
  ): T {
    const paths = this.paths(root);
    if (!recovering) this.checkRecoveryGate(root);
    const mutex = this.publishMutex(paths.mutex, root, "transition");
    try {
      if (!recovering) this.checkRecoveryGate(root);
      const state = this.readState(paths.state, root);
      const change = operation(state.record);
      if (change.next !== undefined) {
        assertExactFile(paths.state, state.snapshot);
        assertExactFile(mutex.path, mutex.snapshot);
        if (change.next === null) {
          if (state.snapshot) {
            const retired = join(paths.directory, mutex.record.staged_file);
            this.options.beforePublish?.();
            assertExactFile(paths.state, state.snapshot);
            assertExactFile(mutex.path, mutex.snapshot);
            renameSync(paths.state, retired);
            unlinkSync(retired);
          }
        } else {
          const next = decodeOwnership(JSON.stringify(change.next), root);
          const staged = join(paths.directory, mutex.record.staged_file);
          writeFileSync(staged, `${JSON.stringify(next)}\n`, {
            flag: "wx",
            mode: 0o600,
          });
          if (process.platform !== "win32") chmodSync(staged, 0o600);
          this.options.beforePublish?.();
          assertExactFile(paths.state, state.snapshot);
          assertExactFile(mutex.path, mutex.snapshot);
          this.replaceState(
            paths.state,
            staged,
            join(paths.directory, mutex.record.backup_file),
            state.snapshot !== undefined,
          );
        }
      }
      return change.result;
    } finally {
      try {
        removeIfPresent(join(paths.directory, mutex.record.staged_file));
      } finally {
        this.releaseMutex(mutex);
      }
    }
  }

  private readState(path: string, root: string) {
    const snapshot = readSnapshot(path);
    return {
      snapshot,
      record: snapshot ? decodeOwnership(snapshot.content, root) : undefined,
    };
  }

  private publishMutex(
    path: string,
    root: string,
    role: "transition" | "recovery",
  ): Mutex {
    const paths = writeOwnershipPaths(this.stateDir, root);
    const nonce = randomUUID();
    const record = {
      schema_version: 1 as const,
      canonical_root: root,
      nonce,
      pid: process.pid,
      role,
      staged_file: `${paths.hash}.${nonce}.tmp`,
      backup_file: `${paths.hash}.${nonce}.backup`,
    };
    const temporary = `${path}.${nonce}.publish`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    try {
      const snapshot = readSnapshot(temporary)!;
      try {
        linkSync(temporary, path);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        const existing = this.readMutex(path, root, role);
        if (existing && this.processLiveness(existing.record.pid) === "live") {
          throw busyError("Ownership state transition is already in progress.");
        }
        throw recoveryError(
          "Interrupted or ambiguous ownership mutex requires explicit recovery.",
          error,
        );
      }
      return { path, record, snapshot };
    } finally {
      removeIfPresent(temporary);
    }
  }

  private readMutex(
    path: string,
    root: string,
    role: "transition" | "recovery",
  ): Mutex | undefined {
    const snapshot = readSnapshot(path);
    if (!snapshot) return undefined;
    try {
      const record = mutexSchema.parse(JSON.parse(snapshot.content));
      const paths = writeOwnershipPaths(this.stateDir, root);
      if (
        record.canonical_root !== root ||
        record.role !== role ||
        record.staged_file !== `${paths.hash}.${record.nonce}.tmp` ||
        record.backup_file !== `${paths.hash}.${record.nonce}.backup`
      )
        throw new Error("Mutex identity mismatch");
      return { path, record, snapshot };
    } catch (error) {
      throw recoveryError(`Undecodable ownership mutex: ${path}`, error);
    }
  }

  private releaseMutex(mutex: Mutex): void {
    assertExactFile(mutex.path, mutex.snapshot);
    unlinkSync(mutex.path);
  }

  private replaceState(
    destination: string,
    staged: string,
    backup: string,
    destinationExists: boolean,
  ): void {
    if (this.platform !== "win32" || !destinationExists) {
      renameSync(staged, destination);
      return;
    }

    renameSync(destination, backup);
    try {
      this.options.afterReplacementBackup?.();
      renameSync(staged, destination);
    } catch (error) {
      try {
        if (readSnapshot(destination)) {
          throw recoveryError(
            "Cannot restore the prior ownership state because the destination reappeared.",
          );
        }
        renameSync(backup, destination);
      } catch (restoreError) {
        if (restoreError instanceof WriteOwnershipError) throw restoreError;
        throw recoveryError(
          "Cannot restore the prior ownership state after replacement failure.",
          restoreError,
        );
      }
      throw error;
    }
    removeIfPresent(backup);
  }

  private reconcileInterruptedReplacement(
    root: string,
    paths: ReturnType<typeof writeOwnershipPaths>,
    mutex: Mutex,
  ): void {
    const backupPath = join(paths.directory, mutex.record.backup_file);
    const backup = readSnapshot(backupPath);
    if (!backup) return;
    decodeOwnership(backup.content, root);

    const stagedPath = join(paths.directory, mutex.record.staged_file);
    const state = readSnapshot(paths.state);
    const staged = readSnapshot(stagedPath);

    if (!state) {
      renameSync(backupPath, paths.state);
      return;
    }

    decodeOwnership(state.content, root);
    if (staged) {
      throw recoveryError(
        "Interrupted Windows ownership replacement is ambiguous.",
      );
    }
    removeIfPresent(backupPath);
  }
}

function decodeOwnership(content: string, root: string): WriteOwnershipRecord {
  try {
    const record = ownershipSchema.parse(JSON.parse(content));
    if (record.canonical_root !== root)
      throw new Error("Canonical root mismatch");
    return record;
  } catch (error) {
    throw recoveryError(
      "Undecodable or mismatched write ownership state.",
      error,
    );
  }
}

function validateRoot(root: string): void {
  if (!isAbsolute(root) || resolve(root) !== root || root.includes("\0")) {
    throw new TypeError(
      "Write ownership requires an already validated canonical absolute root.",
    );
  }
}

function ensureSecureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.getuid && metadata.uid !== process.getuid())
  ) {
    throw recoveryError(`Insecure write ownership state directory: ${path}`);
  }
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function readSnapshot(path: string): Snapshot | undefined {
  let fd: number | undefined;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw recoveryError(`Ownership state is not a regular file: ${path}`);
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || (process.getuid && opened.uid !== process.getuid()))
      throw recoveryError(`Insecure ownership state file: ${path}`);
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    return {
      content: readFileSync(fd, "utf8"),
      dev: opened.dev,
      ino: opened.ino,
    };
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    if (error instanceof WriteOwnershipError) throw error;
    throw recoveryError(`Cannot read ownership state: ${path}`, error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertExactFile(path: string, expected: Snapshot | undefined): void {
  const current = readSnapshot(path);
  if (
    current?.content !== expected?.content ||
    current?.dev !== expected?.dev ||
    current?.ino !== expected?.ino
  ) {
    throw recoveryError(`Ownership state changed outside its mutex: ${path}`);
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function probeProcess(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return isCode(error, "ESRCH") ? "dead" : "unknown";
  }
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function recoveryError(message: string, cause?: unknown): WriteOwnershipError {
  return new WriteOwnershipError(
    "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
    message,
    undefined,
    { cause },
  );
}

function busyError(message: string): WriteOwnershipError {
  return new WriteOwnershipError("WRITE_OWNERSHIP_BUSY", message);
}
