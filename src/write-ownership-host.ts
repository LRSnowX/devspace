import * as z from "zod/v4";
import { WriteOwnership, type MutationKind } from "./write-ownership.js";
import type { ProcessMutationLifecycle } from "./process-sessions.js";

export const writeOwnershipSnapshotSchema = z.object({
  state: z.enum([
    "unowned",
    "owned_by_workspace",
    "owned_by_other",
    "recovery_required",
  ]),
  owner_workspace_id: z.string().optional(),
  active_mutation_count: z.number().int().nonnegative(),
});

export function ownershipSnapshot(
  ownership: WriteOwnership,
  root: string,
  workspaceId: string,
) {
  const snapshot = ownership.inspect(root, workspaceId);
  return {
    state: snapshot.state,
    ...(snapshot.ownerWorkspaceId
      ? { owner_workspace_id: snapshot.ownerWorkspaceId }
      : {}),
    active_mutation_count: snapshot.activeMutations.length,
  };
}

/** Host glue only; all authority and activity identity checks stay in the core. */
export async function withOwnedMutation<T>(
  ownership: WriteOwnership,
  root: string,
  workspaceId: string,
  kind: MutationKind,
  operation: () => Promise<T>,
): Promise<T> {
  const activity = ownership.beginMutation(root, workspaceId, kind, {
    processIds: [process.pid],
    complete: true,
  });
  try {
    return await operation();
  } finally {
    ownership.endMutation(activity);
  }
}

export function beginOwnedProcess(
  ownership: WriteOwnership,
  root: string,
  workspaceId: string,
): ProcessMutationLifecycle {
  const activity = ownership.beginMutation(root, workspaceId, "shell_process");
  return {
    spawned(pid) {
      // Arbitrary shells may create descendants. A shell PID is useful evidence,
      // but not an exhaustive executor list for explicit post-crash recovery.
      ownership.recordMutationExecutors(activity, {
        processIds: [pid],
        complete: false,
      });
    },
    finished() {
      ownership.endMutation(activity);
    },
  };
}

/** A synchronous shell call also owns its post-exit output/result handling. */
export async function withOwnedShellCall<T>(
  ownership: WriteOwnership,
  root: string,
  workspaceId: string,
  operation: (executor: ProcessMutationLifecycle) => Promise<T>,
): Promise<T> {
  const mutation = beginOwnedProcess(ownership, root, workspaceId);
  try {
    return await operation({
      spawned: (pid) => mutation.spawned(pid),
      // ownedBashOperations awaits terminal state before returning. The claim's
      // activity additionally covers Pi's output formatting and error handling.
      finished() {},
    });
  } finally {
    mutation.finished();
  }
}
