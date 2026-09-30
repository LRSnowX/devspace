import { realpath } from "node:fs/promises";
import { Result, type Result as BetterResult } from "better-result";
import type { ServerConfig } from "./config.js";
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

type RetentionConfig = Pick<ServerConfig, "stateDir" | "allowedRoots">;

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
  return Result.ok({
    cutoff: cutoff.toISOString(),
    eligible: [
      ...classifiedCheckouts.eligible,
      ...classifiedPrunedWorktrees.eligible,
    ],
    skipped: [
      ...classifiedCheckouts.skipped,
      ...classifiedPrunedWorktrees.skipped,
    ],
  });
}

export async function pruneWorkspaceMetadataRetention(
  config: RetentionConfig,
  now = new Date(),
  protectedRoots: ReadonlySet<string> = new Set(),
): Promise<BetterResult<WorkspaceMetadataRetentionPruneResult, WorkspaceStoreError>> {
  const opened = createWorkspaceStoreResult(config.stateDir);
  if (opened.isErr()) return opened;

  const cutoff = new Date(now.getTime() - DEFAULT_WORKSPACE_METADATA_RETENTION_MS);
  const listedCheckouts = opened.value.listStaleCheckoutSessions(cutoff);
  if (listedCheckouts.isErr()) {
    closeWorkspaceStoreResult(opened.value);
    return listedCheckouts;
  }
  const listedPrunedWorktrees = opened.value.listStalePrunedManagedWorktrees(cutoff);
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
  const classified = {
    eligible: [
      ...classifiedCheckouts.eligible,
      ...classifiedPrunedWorktrees.eligible,
    ],
    skipped: [
      ...classifiedCheckouts.skipped,
      ...classifiedPrunedWorktrees.skipped,
    ],
  };
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
      const deleted = candidate.kind === "stale_checkout"
        ? opened.value.deleteStaleCheckoutSession(candidate.workspaceId, cutoff)
        : opened.value.deleteDisposablePrunedWorktreeSession(
            candidate.workspaceId,
            cutoff,
          );
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
    }
  } finally {
    const closed = closeWorkspaceStoreResult(opened.value);
    if (closed.isErr()) return closed;
  }

  return Result.ok(result);
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
