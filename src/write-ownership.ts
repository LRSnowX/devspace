import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  WriteOwnershipStore,
  WriteOwnershipError,
  type WriteOwnershipRecord,
  type WriteOwnershipStoreOptions,
  type MutationKind,
  type DestructiveRetentionRecord,
} from "./write-ownership-store.js";

export { WriteOwnershipError } from "./write-ownership-store.js";
export type {
  WriteOwnershipRecord,
  MutationKind,
  ProcessLiveness,
} from "./write-ownership-store.js";

/** The caller supplies WorkspaceRegistry's validated canonical root; this core
 * never resolves an invalidated workspace to a different filesystem identity. */
export interface MutationActivity {
  canonicalRoot: string;
  workspaceId: string;
  ownershipId: string;
  activityId: string;
}

export interface MutationExecutors {
  processIds: readonly number[];
  /** True only when these identify every executor that could still mutate.
   * A parent PID alone is insufficient for a shell/provider operation. */
  complete: boolean;
}

export interface DestructiveRetentionGuard {
  canonicalRoot: string;
  guardId: string;
}

export class WriteOwnership {
  private readonly store: WriteOwnershipStore;

  constructor(stateDir: string, options: WriteOwnershipStoreOptions = {}) {
    this.store = new WriteOwnershipStore(stateDir, options);
  }

  inspect(canonicalRoot: string, workspaceId: string) {
    validateWorkspaceId(workspaceId);
    let record: WriteOwnershipRecord | undefined;
    try {
      record = this.store.inspect(canonicalRoot);
    } catch (error) {
      if (
        error instanceof WriteOwnershipError &&
        error.code === "WRITE_OWNERSHIP_RECOVERY_REQUIRED"
      ) {
        return {
          state: "recovery_required" as const,
          ownerWorkspaceId: undefined,
          acquiredAt: undefined,
          activeMutations: [],
        };
      }
      throw error;
    }
    return {
      state:
        record === undefined
          ? ("unowned" as const)
          : record.owner_workspace_id === workspaceId
            ? ("owned_by_workspace" as const)
            : ("owned_by_other" as const),
      ownerWorkspaceId: record?.owner_workspace_id,
      acquiredAt: record?.acquired_at,
      activeMutations: record?.active_mutations ?? [],
    };
  }

  acquire(canonicalRoot: string, workspaceId: string) {
    validateWorkspaceId(workspaceId);
    return this.store.transition<{ status: "acquired" | "already_owned" }>(
      canonicalRoot,
      (record) => {
        if (record) {
          requireOwner(record, workspaceId);
          return { result: { status: "already_owned" as const } };
        }
        return {
          next: {
            schema_version: 1,
            canonical_root: canonicalRoot,
            ownership_id: randomUUID(),
            owner_workspace_id: workspaceId,
            acquired_at: new Date().toISOString(),
            active_mutations: [],
          },
          result: { status: "acquired" as const },
        };
      },
    );
  }

  release(canonicalRoot: string, workspaceId: string) {
    validateWorkspaceId(workspaceId);
    return this.store.transition<{ status: "released" | "not_owned" }>(
      canonicalRoot,
      (record) => {
        if (!record) return { result: { status: "not_owned" as const } };
        requireOwner(record, workspaceId);
        if (record.active_mutations.length > 0) {
          throw new WriteOwnershipError(
            "WRITE_OWNERSHIP_BUSY",
            "Active mutations prevent ownership release.",
            record,
          );
        }
        return { next: null, result: { status: "released" as const } };
      },
    );
  }

  beginMutation(
    canonicalRoot: string,
    workspaceId: string,
    kind: MutationKind,
    executors: MutationExecutors = { processIds: [], complete: false },
  ): MutationActivity {
    validateWorkspaceId(workspaceId);
    validateExecutors(executors);
    return this.store.transition(canonicalRoot, (record) => {
      requireOwner(record, workspaceId);
      const activityId = randomUUID();
      record.active_mutations.push({
        activity_id: activityId,
        kind,
        started_at: new Date().toISOString(),
        executor_processes: [...executors.processIds],
        executor_processes_complete: executors.complete,
      });
      return {
        next: record,
        result: {
          canonicalRoot,
          workspaceId,
          ownershipId: record.ownership_id,
          activityId,
        },
      };
    });
  }

  /** Call after spawning actual executors. Evidence is additive: a later update
   * cannot quietly discard a previously recorded mutation-capable process. */
  recordMutationExecutors(
    activity: MutationActivity,
    executors: MutationExecutors,
  ): void {
    validateExecutors(executors);
    this.store.transition(activity.canonicalRoot, (record) => {
      requireActivityOwner(record, activity);
      const mutation = record.active_mutations.find(
        (entry) => entry.activity_id === activity.activityId,
      );
      if (!mutation)
        throw new WriteOwnershipError(
          "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
          "Mutation activity is no longer active.",
          record,
        );
      mutation.executor_processes = [
        ...new Set([...mutation.executor_processes, ...executors.processIds]),
      ];
      mutation.executor_processes_complete = executors.complete;
      return { next: record, result: undefined };
    });
  }

  endMutation(activity: MutationActivity): void {
    this.store.transition(activity.canonicalRoot, (record) => {
      requireActivityOwner(record, activity);
      const index = record.active_mutations.findIndex(
        (entry) => entry.activity_id === activity.activityId,
      );
      if (index < 0) return { result: undefined };
      record.active_mutations.splice(index, 1);
      return { next: record, result: undefined };
    });
  }

  beginDestructiveRetention(
    canonicalRoot: string,
    kind: DestructiveRetentionRecord["kind"],
    executors: MutationExecutors = {
      processIds: [process.pid],
      complete: false,
    },
  ): DestructiveRetentionGuard {
    validateExecutors(executors);
    return this.store.retentionTransition(canonicalRoot, (record) => {
      if (record)
        throw new WriteOwnershipError(
          "WRITE_OWNERSHIP_BUSY",
          "Write ownership prevents destructive retention.",
          record,
        );
      const existing = this.store.readRetention(canonicalRoot);
      if (existing)
        throw new WriteOwnershipError(
          this.store.retentionLiveness(existing) === "live"
            ? "WRITE_OWNERSHIP_BUSY"
            : "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
          "Destructive retention already reserves this root.",
        );
      const guardId = randomUUID();
      let rootIdentity: DestructiveRetentionRecord["root_identity"] = null;
      try {
        const metadata = lstatSync(canonicalRoot);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new WriteOwnershipError(
            "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
            "Retention requires an unambiguous canonical directory.",
          );
        rootIdentity = { dev: String(metadata.dev), ino: String(metadata.ino) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.store.replaceRetention(canonicalRoot, {
        schema_version: 1,
        canonical_root: canonicalRoot,
        guard_id: guardId,
        kind,
        started_at: new Date().toISOString(),
        executor_processes: [...executors.processIds],
        executor_processes_complete: executors.complete,
        root_identity: rootIdentity,
      });
      return { result: { canonicalRoot, guardId } };
    });
  }

  endDestructiveRetention(guard: DestructiveRetentionGuard): void {
    this.store.retentionTransition(guard.canonicalRoot, () => {
      const record = this.store.readRetention(guard.canonicalRoot);
      if (!record) return { result: undefined };
      if (record.guard_id !== guard.guardId)
        throw new WriteOwnershipError(
          "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
          "Retention handle belongs to a different guard.",
        );
      this.store.replaceRetention(guard.canonicalRoot, undefined, record);
      return { result: undefined };
    });
  }

  recordRetentionExecutors(
    guard: DestructiveRetentionGuard,
    executors: MutationExecutors,
  ): void {
    validateExecutors(executors);
    this.store.retentionTransition(guard.canonicalRoot, () => {
      const record = this.store.readRetention(guard.canonicalRoot);
      if (!record || record.guard_id !== guard.guardId)
        throw new WriteOwnershipError(
          "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
          "Retention handle no longer identifies the current guard.",
        );
      record.executor_processes = [
        ...new Set([...record.executor_processes, ...executors.processIds]),
      ];
      record.executor_processes_complete = executors.complete;
      this.store.replaceRetention(guard.canonicalRoot, record, record);
      return { result: undefined };
    });
  }

  diagnostics(canonicalRoot: string) {
    const errors: string[] = [];
    let ownership: WriteOwnershipRecord | undefined;
    let retention: DestructiveRetentionRecord | undefined;
    try {
      ownership = this.store.inspect(canonicalRoot);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      retention = this.store.readRetention(canonicalRoot);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return { canonical_root: canonicalRoot, ownership, retention, errors };
  }


  list() {
    const discovered = this.store.list();
    return {
      roots: discovered.roots.map((root) => this.diagnostics(root)),
      errors: discovered.errors,
    };
  }

  recover(
    canonicalRoot: string,
    verifyRetentionSafe?: (guard: DestructiveRetentionRecord) => boolean,
  ) {
    return this.store.recover<{
      status: "recovered" | "not_owned";
      previousOwnerWorkspaceId?: string;
      recoveredActivityIds: string[];
    }>(canonicalRoot, (record) => {
      const guard = this.store.readRetention(canonicalRoot);
      if (guard) {
        if (record)
          throw new WriteOwnershipError(
            "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
            "Ownership and retention coexist unexpectedly.",
            record,
          );
        const liveness = this.store.retentionLiveness(guard);
        if (liveness === "live")
          throw new WriteOwnershipError(
            "WRITE_OWNERSHIP_BUSY",
            "A destructive retention executor is still alive.",
          );
        if (liveness !== "dead" || !verifyRetentionSafe?.(guard))
          throw new WriteOwnershipError(
            "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
            "Retention executor evidence or filesystem lifecycle is ambiguous.",
          );
        this.store.replaceRetention(canonicalRoot, undefined, guard);
        return {
          result: { status: "recovered" as const, recoveredActivityIds: [] },
        };
      }
      if (!record)
        return {
          result: {
            status: "not_owned" as const,
            recoveredActivityIds: [] as string[],
          },
        };
      for (const mutation of record.active_mutations) {
        if (
          !mutation.executor_processes_complete ||
          mutation.executor_processes.length === 0
        ) {
          throw new WriteOwnershipError(
            "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
            "Mutation executor evidence is incomplete.",
            record,
          );
        }
        for (const pid of mutation.executor_processes) {
          const liveness = this.store.processLiveness(pid);
          if (liveness === "live") {
            throw new WriteOwnershipError(
              "WRITE_OWNERSHIP_BUSY",
              `Mutation executor ${pid} is still alive.`,
              record,
            );
          }
          if (liveness !== "dead") {
            throw new WriteOwnershipError(
              "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
              `Mutation executor ${pid} liveness is ambiguous.`,
              record,
            );
          }
        }
      }
      return {
        next: null,
        result: {
          status: "recovered" as const,
          previousOwnerWorkspaceId: record.owner_workspace_id,
          recoveredActivityIds: record.active_mutations.map(
            (entry) => entry.activity_id,
          ),
        },
      };
    });
  }


}

function validateWorkspaceId(workspaceId: string): void {
  if (
    !workspaceId ||
    workspaceId.trim() !== workspaceId ||
    workspaceId.includes("\0")
  ) {
    throw new TypeError("A nonempty workspace id is required.");
  }
}

function validateExecutors(executors: MutationExecutors): void {
  if (
    typeof executors.complete !== "boolean" ||
    !Array.isArray(executors.processIds) ||
    executors.processIds.some(
      (pid) => !Number.isSafeInteger(pid) || pid <= 0,
    ) ||
    new Set(executors.processIds).size !== executors.processIds.length ||
    (executors.complete && executors.processIds.length === 0)
  ) {
    throw new TypeError("Invalid mutation executor evidence.");
  }
}

function requireOwner(
  record: WriteOwnershipRecord | undefined,
  workspaceId: string,
): asserts record is WriteOwnershipRecord {
  if (!record)
    throw new WriteOwnershipError(
      "WRITE_OWNERSHIP_REQUIRED",
      "Write ownership has not been acquired.",
    );
  if (record.owner_workspace_id !== workspaceId) {
    throw new WriteOwnershipError(
      "WRITE_OWNERSHIP_CONFLICT",
      "Another workspace owns this canonical root.",
      record,
    );
  }
}

function requireActivityOwner(
  record: WriteOwnershipRecord | undefined,
  activity: MutationActivity,
): asserts record is WriteOwnershipRecord {
  requireOwner(record, activity.workspaceId);
  if (record.ownership_id !== activity.ownershipId) {
    throw new WriteOwnershipError(
      "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
      "Mutation handle belongs to a different ownership claim.",
      record,
    );
  }
}
