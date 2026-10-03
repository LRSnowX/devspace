import { realpath } from "node:fs/promises";
import { Result, type Result as BetterResult } from "better-result";
import type { ServerConfig } from "./config.js";
import { WriteOwnership, WriteOwnershipError } from "./write-ownership.js";
import { managedWorktreeRecoveryRefExists } from "./git-worktrees.js";
import { deleteWorkspaceReviewRefs } from "./review-checkpoints.js";
import { resolveCanonicalAllowedPath } from "./roots.js";
import {
  closeWorkspaceStoreResult,
  createWorkspaceStoreResult,
  type WorkspaceSession,
  type WorkspaceStoreError,
} from "./workspace-store.js";

export const DEFAULT_WORKSPACE_METADATA_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface WorkspaceMetadataRetentionCandidate {
  workspaceId: string;
  root: string;
  reviewRoot: string;
  lastUsedAt: string;
  kind: "stale_checkout" | "disposable_pruned_worktree";
}

export interface WorkspaceMetadataRetentionSkipped {
  workspaceId: string;
  root: string;
  reason:
    | "patch_recovery_required"
    | "write_ownership_present"
    | "write_ownership_recovery_required"
    | "root_invalid"
    | "recovery_metadata_present"
    | "recovery_ref_present"
    | "recovery_state_unverifiable";
}

export interface WorkspaceMetadataRetentionInspection {
  cutoff: string;
  eligible: WorkspaceMetadataRetentionCandidate[];
  skipped: WorkspaceMetadataRetentionSkipped[];
}

export interface WorkspaceMetadataRetentionPruneResult extends WorkspaceMetadataRetentionInspection {
  pruned: string[];
  stateChanged: string[];
  failed: Array<{ workspaceId: string; error: string }>;
  reviewRefsDeleted: number;
  reviewCleanupFailed: Array<{ workspaceId: string; error: string }>;
}

type RetentionConfig = Pick<ServerConfig, "stateDir" | "allowedRoots" | "worktreeRoot">;

export async function inspectWorkspaceMetadataRetention(
  config: RetentionConfig,
  now = new Date(),
  protectedRoots: ReadonlySet<string> = new Set(),
): Promise<BetterResult<WorkspaceMetadataRetentionInspection, WorkspaceStoreError>> {
  const opened = createWorkspaceStoreResult(config.stateDir);
  if (opened.isErr()) return opened;

  const cutoff = new Date(now.getTime() - DEFAULT_WORKSPACE_METADATA_RETENTION_MS);
  let listedCheckouts!: ReturnType<typeof opened.value.listStaleCheckoutSessions>;
  let listedPrunedWorktrees!: ReturnType<
    typeof opened.value.listStalePrunedManagedWorktrees
  >;
  let closed!: ReturnType<typeof closeWorkspaceStoreResult>;
  try {
    listedCheckouts = opened.value.listStaleCheckoutSessions(cutoff);
    listedPrunedWorktrees = opened.value.listStalePrunedManagedWorktrees(cutoff);
  } finally {
    closed = closeWorkspaceStoreResult(opened.value);
  }
  if (listedCheckouts.isErr()) return listedCheckouts;
  if (listedPrunedWorktrees.isErr()) return listedPrunedWorktrees;
  if (closed.isErr()) return closed;

  const classifiedCheckouts = await classifyCheckoutCandidates(
    listedCheckouts.value,
    config.allowedRoots,
    protectedRoots,
  );
  const classifiedPrunedWorktrees = await classifyPrunedWorktreeCandidates(
    listedPrunedWorktrees.value,
    config.allowedRoots,
    protectedRoots,
  );
  const classified = await protectOwnedMetadata(config, {
    eligible: [...classifiedCheckouts.eligible, ...classifiedPrunedWorktrees.eligible],
    skipped: [...classifiedCheckouts.skipped, ...classifiedPrunedWorktrees.skipped],
  });
  return Result.ok({
    cutoff: cutoff.toISOString(),
    ...classified,
  });
}

export async function pruneWorkspaceMetadataRetention(
  config: RetentionConfig,
  now = new Date(),
  protectedRoots: ReadonlySet<string> = new Set(),
): Promise<
  BetterResult<WorkspaceMetadataRetentionPruneResult, WorkspaceStoreError>
> {
  const opened = createWorkspaceStoreResult(config.stateDir);
  if (opened.isErr()) return opened;

  const cutoff = new Date(
    now.getTime() - DEFAULT_WORKSPACE_METADATA_RETENTION_MS,
  );
  const listedCheckouts = opened.value.listStaleCheckoutSessions(cutoff);
  if (listedCheckouts.isErr()) {
    closeWorkspaceStoreResult(opened.value);
    return listedCheckouts;
  }
  const listedPrunedWorktrees =
    opened.value.listStalePrunedManagedWorktrees(cutoff);
  if (listedPrunedWorktrees.isErr()) {
    closeWorkspaceStoreResult(opened.value);
    return listedPrunedWorktrees;
  }

  const classifiedCheckouts = await classifyCheckoutCandidates(
    listedCheckouts.value,
    config.allowedRoots,
    protectedRoots,
  );
  const classifiedPrunedWorktrees = await classifyPrunedWorktreeCandidates(
    listedPrunedWorktrees.value,
    config.allowedRoots,
    protectedRoots,
  );
  const classified = await protectOwnedMetadata(config, {
    eligible: [
      ...classifiedCheckouts.eligible,
      ...classifiedPrunedWorktrees.eligible,
    ],
    skipped: [
      ...classifiedCheckouts.skipped,
      ...classifiedPrunedWorktrees.skipped,
    ],
  });
  const ownership = new WriteOwnership(config.stateDir);
  const result: WorkspaceMetadataRetentionPruneResult = {
    cutoff: cutoff.toISOString(),
    ...classified,
    pruned: [],
    stateChanged: [],
    failed: [],
    reviewRefsDeleted: 0,
    reviewCleanupFailed: [],
  };

  try {
    for (const candidate of classified.eligible) {
      let guard;
      try {
        const canonicalRoot = await metadataCanonicalRoot(config, candidate);
        guard = ownership.beginDestructiveRetention(
          canonicalRoot,
          "workspace_metadata",
          { processIds: [process.pid], complete: true },
        );
      } catch (error) {
        if (!(error instanceof WriteOwnershipError)) {
          result.skipped.push({
            workspaceId: candidate.workspaceId,
            root: candidate.root,
            reason: "root_invalid",
          });
          continue;
        }
        result.skipped.push({
          workspaceId: candidate.workspaceId,
          root: candidate.root,
          reason:
            error.code === "WRITE_OWNERSHIP_BUSY"
              ? "write_ownership_present"
              : "write_ownership_recovery_required",
        });
        continue;
      }
      let safeTerminal = false;
      try {
        const deleted =
          candidate.kind === "stale_checkout"
            ? opened.value.deleteStaleCheckoutSession(
                candidate.workspaceId,
                cutoff,
              )
            : opened.value.deleteDisposablePrunedWorktreeSession(
                candidate.workspaceId,
                cutoff,
              );
        // SQLite has returned a definite transactional outcome. Review ref
        // cleanup is inside the reservation but does not delete checkout files.
        safeTerminal = true;
        if (deleted.isErr()) {
          result.failed.push({
            workspaceId: candidate.workspaceId,
            error: deleted.error.message,
          });
          continue;
        }
        if (!deleted.value) {
          result.stateChanged.push(candidate.workspaceId);
          continue;
        }
        result.pruned.push(candidate.workspaceId);

        try {
          // External Git work makes a parent PID insufficient crash evidence.
          ownership.recordRetentionExecutors(guard, {
            processIds: [process.pid],
            complete: false,
          });
          result.reviewRefsDeleted += await deleteWorkspaceReviewRefs(
            candidate.reviewRoot,
            candidate.workspaceId,
          );
        } catch (error) {
          result.reviewCleanupFailed.push({
            workspaceId: candidate.workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (safeTerminal) {
          try {
            ownership.endDestructiveRetention(guard);
          } catch (error) {
            result.failed.push({
              workspaceId: candidate.workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  } finally {
    const closed = closeWorkspaceStoreResult(opened.value);
    if (closed.isErr()) return closed;
  }

  return Result.ok(result);
}

async function protectOwnedMetadata(
  config: RetentionConfig,
  classified: Pick<
    WorkspaceMetadataRetentionInspection,
    "eligible" | "skipped"
  >,
): Promise<Pick<WorkspaceMetadataRetentionInspection, "eligible" | "skipped">> {
  const ownership = new WriteOwnership(config.stateDir);
  const eligible: WorkspaceMetadataRetentionCandidate[] = [];
  for (const candidate of classified.eligible) {
    try {
      const root = await metadataCanonicalRoot(config, candidate);
      const snapshot = ownership.inspect(root, candidate.workspaceId);
      const diagnostics = ownership.diagnostics(root);
      if (
        snapshot.state !== "unowned" ||
        diagnostics.retention ||
        diagnostics.errors.length
      ) {
        classified.skipped.push({
          workspaceId: candidate.workspaceId,
          root: candidate.root,
          reason:
            snapshot.state === "recovery_required" || diagnostics.errors.length
              ? "write_ownership_recovery_required"
              : "write_ownership_present",
        });
      } else eligible.push(candidate);
    } catch {
      classified.skipped.push({
        workspaceId: candidate.workspaceId,
        root: candidate.root,
        reason: "write_ownership_recovery_required",
      });
    }
  }
  return { eligible, skipped: classified.skipped };
}

function metadataCanonicalRoot(
  config: RetentionConfig,
  candidate: WorkspaceMetadataRetentionCandidate,
) {
  const boundaries =
    candidate.kind === "stale_checkout"
      ? [...config.allowedRoots]
      : [config.worktreeRoot];
  return resolveCanonicalAllowedPath(
    candidate.root,
    candidate.root,
    boundaries,
  );
}

async function classifyCheckoutCandidates(
  sessions: readonly WorkspaceSession[],
  allowedRoots: readonly string[],
  protectedRoots: ReadonlySet<string>,
): Promise<Pick<WorkspaceMetadataRetentionInspection, "eligible" | "skipped">> {
  const eligible: WorkspaceMetadataRetentionCandidate[] = [];
  const skipped: WorkspaceMetadataRetentionSkipped[] = [];

  for (const session of sessions) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await resolveCanonicalAllowedPath(
        session.root,
        session.root,
        [...allowedRoots],
      );
    } catch {
      skipped.push({
        workspaceId: session.id,
        root: session.root,
        reason: "root_invalid",
      });
      continue;
    }

    let existingCanonicalRoot = canonicalRoot;
    try {
      existingCanonicalRoot = await realpath(session.root);
    } catch {
      // Missing stale checkout roots can still have their metadata pruned.
    }
    if (
      protectedRoots.has(session.root)
      || protectedRoots.has(canonicalRoot)
      || protectedRoots.has(existingCanonicalRoot)
    ) {
      skipped.push({
        workspaceId: session.id,
        root: session.root,
        reason: "patch_recovery_required",
      });
      continue;
    }

    eligible.push({
      workspaceId: session.id,
      root: session.root,
      reviewRoot: session.root,
      lastUsedAt: session.lastUsedAt,
      kind: "stale_checkout",
    });
  }

  return { eligible, skipped };
}

async function classifyPrunedWorktreeCandidates(
  sessions: readonly WorkspaceSession[],
  allowedRoots: readonly string[],
  protectedRoots: ReadonlySet<string>,
): Promise<Pick<WorkspaceMetadataRetentionInspection, "eligible" | "skipped">> {
  const eligible: WorkspaceMetadataRetentionCandidate[] = [];
  const skipped: WorkspaceMetadataRetentionSkipped[] = [];

  for (const session of sessions) {
    if (
      protectedRoots.has(session.root)
      || (session.sourceRoot ? protectedRoots.has(session.sourceRoot) : false)
    ) {
      skipped.push({
        workspaceId: session.id,
        root: session.root,
        reason: "patch_recovery_required",
      });
      continue;
    }

    if (session.recoveryKind) {
      skipped.push({
        workspaceId: session.id,
        root: session.root,
        reason: "recovery_metadata_present",
      });
      continue;
    }

    const recoveryRef = await managedWorktreeRecoveryRefExists({
      session,
      allowedRoots: [...allowedRoots],
    });
    if (recoveryRef.isErr()) {
      skipped.push({
        workspaceId: session.id,
        root: session.root,
        reason: "recovery_state_unverifiable",
      });
      continue;
    }
    if (recoveryRef.value) {
      skipped.push({
        workspaceId: session.id,
        root: session.root,
        reason: "recovery_ref_present",
      });
      continue;
    }
    if (!session.sourceRoot) {
      skipped.push({
        workspaceId: session.id,
        root: session.root,
        reason: "recovery_state_unverifiable",
      });
      continue;
    }

    eligible.push({
      workspaceId: session.id,
      root: session.root,
      reviewRoot: session.sourceRoot,
      lastUsedAt: session.lastUsedAt,
      kind: "disposable_pruned_worktree",
    });
  }

  return { eligible, skipped };
}
