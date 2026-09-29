import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPEAT_FAILURE_THRESHOLD,
  RepeatFailureCircuitBreaker,
} from "./repeat-failure-circuit.js";

const request = {
  patch: "*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch",
  expectedRevisions: [
    { path: "b.txt", revision: `sha256:${"b".repeat(64)}` },
    { path: "a.txt", revision: `sha256:${"a".repeat(64)}` },
  ],
};

test("repeat failure circuit opens only after the configured failure threshold", () => {
  const circuit = new RepeatFailureCircuitBreaker();
  const workspaceId = "ws_repeat";

  for (let count = 1; count <= REPEAT_FAILURE_THRESHOLD; count += 1) {
    assert.equal(circuit.beforeAttempt(workspaceId, request), undefined);
    assert.equal(
      circuit.recordFailure(workspaceId, request, "REVISION_CONFLICT"),
      count,
    );
  }

  assert.deepEqual(circuit.beforeAttempt(workspaceId, request), {
    code: "REPEATED_FAILURE",
    category: "state",
    message:
      "Repeated identical apply_patch request blocked after 3 consecutive failures. Change the patch or expected revisions, or re-read the relevant files before retrying.",
    retryable: false,
    repeat_count: 3,
    previous_error_code: "REVISION_CONFLICT",
  });
});

test("expected revision order does not bypass the repeat failure circuit", () => {
  const circuit = new RepeatFailureCircuitBreaker();
  const workspaceId = "ws_order";
  for (let count = 0; count < REPEAT_FAILURE_THRESHOLD; count += 1) {
    circuit.recordFailure(workspaceId, request, "PATCH_INVALID");
  }

  const reordered = {
    ...request,
    expectedRevisions: [...request.expectedRevisions].reverse(),
  };
  assert.equal(circuit.beforeAttempt(workspaceId, reordered)?.code, "REPEATED_FAILURE");
});

test("a changed request or successful apply clears the failure streak", () => {
  const circuit = new RepeatFailureCircuitBreaker();
  const workspaceId = "ws_reset";
  for (let count = 0; count < REPEAT_FAILURE_THRESHOLD; count += 1) {
    circuit.recordFailure(workspaceId, request, "PATCH_INVALID");
  }

  const changed = { ...request, patch: `${request.patch}\n` };
  assert.equal(circuit.beforeAttempt(workspaceId, changed), undefined);
  assert.equal(circuit.beforeAttempt(workspaceId, request), undefined);

  circuit.recordFailure(workspaceId, request, "PATCH_INVALID");
  circuit.recordSuccess(workspaceId);
  assert.equal(circuit.beforeAttempt(workspaceId, request), undefined);
});
