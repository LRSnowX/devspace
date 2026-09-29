import { createHash } from "node:crypto";
import type { ExpectedFileRevision } from "./apply-patch.js";
import type { ToolErrorCode, ToolErrorPayload } from "./tool-errors.js";

export const REPEAT_FAILURE_THRESHOLD = 3;
const MAX_TRACKED_WORKSPACES = 256;

interface FailureEntry {
  fingerprint: string;
  failures: number;
  lastErrorCode: ToolErrorCode;
}

export interface RepeatFailureRequest {
  patch: string;
  expectedRevisions?: readonly ExpectedFileRevision[];
  expectedAbsentPaths?: readonly string[];
}

export class RepeatFailureCircuitBreaker {
  private readonly entries = new Map<string, FailureEntry>();

  beforeAttempt(
    workspaceId: string,
    request: RepeatFailureRequest,
  ): ToolErrorPayload | undefined {
    const fingerprint = requestFingerprint(request);
    const entry = this.entries.get(workspaceId);
    if (!entry) return undefined;

    if (entry.fingerprint !== fingerprint) {
      this.entries.delete(workspaceId);
      return undefined;
    }

    this.touch(workspaceId, entry);
    if (entry.failures < REPEAT_FAILURE_THRESHOLD) return undefined;

    return {
      code: "REPEATED_FAILURE",
      category: "state",
      message:
        `Repeated identical apply_patch request blocked after ${entry.failures} consecutive failures. Change the patch or preconditions, or re-read the relevant files before retrying.`,
      retryable: false,
      repeat_count: entry.failures,
      previous_error_code: entry.lastErrorCode,
    };
  }

  recordFailure(
    workspaceId: string,
    request: RepeatFailureRequest,
    errorCode: ToolErrorCode,
  ): number {
    const fingerprint = requestFingerprint(request);
    const current = this.entries.get(workspaceId);
    const entry: FailureEntry =
      current?.fingerprint === fingerprint
        ? {
            fingerprint,
            failures: current.failures + 1,
            lastErrorCode: errorCode,
          }
        : {
            fingerprint,
            failures: 1,
            lastErrorCode: errorCode,
          };

    this.touch(workspaceId, entry);
    this.trim();
    return entry.failures;
  }

  recordSuccess(workspaceId: string): void {
    this.entries.delete(workspaceId);
  }

  reset(workspaceId: string): void {
    this.entries.delete(workspaceId);
  }

  private touch(workspaceId: string, entry: FailureEntry): void {
    this.entries.delete(workspaceId);
    this.entries.set(workspaceId, entry);
  }

  private trim(): void {
    while (this.entries.size > MAX_TRACKED_WORKSPACES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

function requestFingerprint(request: RepeatFailureRequest): string {
  const expectedRevisions = [...(request.expectedRevisions ?? [])]
    .map(({ path, revision }) => ({ path, revision }))
    .sort((left, right) =>
      left.path.localeCompare(right.path) || left.revision.localeCompare(right.revision),
    );
  const expectedAbsentPaths = [...(request.expectedAbsentPaths ?? [])].sort();
  return createHash("sha256")
    .update(JSON.stringify({
      patch: request.patch,
      expected_revisions: expectedRevisions,
      expected_absent_paths: expectedAbsentPaths,
    }))
    .digest("hex");
}
