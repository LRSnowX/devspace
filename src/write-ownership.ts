import { randomUUID } from "node:crypto";
import {
  WriteOwnershipStore,
  WriteOwnershipError,
  type WriteOwnershipRecord,
  type WriteOwnershipStoreOptions,
  type MutationKind,
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

  recover(canonicalRoot: string) {
    return this.store.recover<{
      status: "recovered" | "not_owned";
      previousOwnerWorkspaceId?: string;
      recoveredActivityIds: string[];
    }>(canonicalRoot, (record) => {
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
