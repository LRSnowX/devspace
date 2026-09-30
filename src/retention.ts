import { realpath } from "node:fs/promises";
import { Result, type Result as BetterResult } from "better-result";
import type { ServerConfig } from "./config.js";
import { deleteWorkspaceReviewRefs } from "./review-checkpoints.js";
import { resolveCanonicalAllowedPath } from "./roots.js";
import {
  closeWorkspaceStoreResult,
  createWorkspaceStoreResult,
  type WorkspaceSession,
  type WorkspaceStoreError,
} from "./workspace-store.js";

export const DEFAULT_CHECKOUT_SESSION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface CheckoutRetentionCandidate {
  workspaceId: string;
  root: string;
  lastUsedAt: string;
}

export interface CheckoutRetentionSkipped {
  workspaceId: string;
  root: string;
  reason: "patch_recovery_required" | "root_invalid";
}

export interface CheckoutRetentionInspection {
  cutoff: string;
  eligible: CheckoutRetentionCandidate[];
  skipped: CheckoutRetentionSkipped[];
}

export interface CheckoutRetentionPruneResult extends CheckoutRetentionInspection {
  pruned: string[];
  failed: Array<{ workspaceId: string; error: string }>;
  reviewRefsDeleted: number;
  reviewCleanupFailed: Array<{ workspaceId: string; error: string }>;
}

type RetentionConfig = Pick<ServerConfig, "stateDir" | "allowedRoots">;

export async function inspectCheckoutRetention(
  config: RetentionConfig,
  now = new Date(),
  protectedRoots: ReadonlySet<string> = new Set(),
): Promise<BetterResult<CheckoutRetentionInspection, WorkspaceStoreError>> {
  const opened = createWorkspaceStoreResult(config.stateDir);
  if (opened.isErr()) return opened;

  const cutoff = new Date(now.getTime() - DEFAULT_CHECKOUT_SESSION_RETENTION_MS);
  let listed!: ReturnType<typeof opened.value.listStaleCheckoutSessions>;
  let closed!: ReturnType<typeof closeWorkspaceStoreResult>;
  try {
    listed = opened.value.listStaleCheckoutSessions(cutoff);
  } finally {
    closed = closeWorkspaceStoreResult(opened.value);
  }
  if (listed.isErr()) return listed;
  if (closed.isErr()) return closed;

  const classified = await classifyCandidates(
    listed.value,
    config.allowedRoots,
    protectedRoots,
  );
  return Result.ok({
    cutoff: cutoff.toISOString(),
    ...classified,
  });
}

export async function pruneCheckoutRetention(
  config: RetentionConfig,
  now = new Date(),
  protectedRoots: ReadonlySet<string> = new Set(),
): Promise<BetterResult<CheckoutRetentionPruneResult, WorkspaceStoreError>> {
  const opened = createWorkspaceStoreResult(config.stateDir);
  if (opened.isErr()) return opened;

  const cutoff = new Date(now.getTime() - DEFAULT_CHECKOUT_SESSION_RETENTION_MS);
  const listed = opened.value.listStaleCheckoutSessions(cutoff);
  if (listed.isErr()) {
    closeWorkspaceStoreResult(opened.value);
    return listed;
  }

  const classified = await classifyCandidates(
    listed.value,
    config.allowedRoots,
    protectedRoots,
  );
  const result: CheckoutRetentionPruneResult = {
    cutoff: cutoff.toISOString(),
    ...classified,
    pruned: [],
    failed: [],
    reviewRefsDeleted: 0,
    reviewCleanupFailed: [],
  };

  try {
    for (const candidate of classified.eligible) {
      const deleted = opened.value.deleteSession(candidate.workspaceId);
      if (deleted.isErr()) {
        result.failed.push({
          workspaceId: candidate.workspaceId,
          error: deleted.error.message,
        });
        continue;
      }
      result.pruned.push(candidate.workspaceId);

      try {
        result.reviewRefsDeleted += await deleteWorkspaceReviewRefs(
          candidate.root,
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

async function classifyCandidates(
  sessions: readonly WorkspaceSession[],
  allowedRoots: readonly string[],
  protectedRoots: ReadonlySet<string>,
): Promise<Pick<CheckoutRetentionInspection, "eligible" | "skipped">> {
  const eligible: CheckoutRetentionCandidate[] = [];
  const skipped: CheckoutRetentionSkipped[] = [];

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
      lastUsedAt: session.lastUsedAt,
    });
  }

  return { eligible, skipped };
}
