import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { MemoryBootstrapContext, MemoryClient } from "./memory-adapter.js";
import {
  formatProjectMemoryInspection,
  inspectProjectMemory,
  resolveMemoryInspectionProject,
} from "./memory-inspect.js";
import { ProjectRegistry } from "./project-registry.js";

const execFileAsync = promisify(execFile);

test("memory inspection combines live repository freshness, handoff and CHIM health", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-memory-inspect-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const memory = fakeMemory();
  const inspection = await inspectProjectMemory({
    projectName: "LEMonX",
    projectPath: root,
    memory,
    byteBudget: 12_288,
  });

  assert.equal(inspection.repository_state.available, true);
  assert.equal(typeof inspection.repository_state.head_committed_at, "number");
  assert.equal(inspection.memory.enabled, true);
  assert.equal(inspection.memory.context_error, undefined);
  assert.equal(inspection.memory.health_error, undefined);
  const working = inspection.memory.context?.working_memory as Record<string, unknown>;
  const verification = working.verification as Array<Record<string, unknown>>;
  assert.equal(verification[0]?.memory_id, "current-goal");
  assert.equal(verification[0]?.source_state, "current_by_evidence");
  assert.equal(verification[0]?.host_state, "needs_revalidation");
  assert.match(verification[0]?.host_reason as string, /HEAD is newer/);
  assert.equal(inspection.memory.health?.project, "LEMonX");
  assert.equal(
    (inspection.memory.health?.memory_items as Record<string, unknown>).active,
    1,
  );
  assert.match(formatProjectMemoryInspection(inspection), /working items 1 · flagged 1/);
  assert.match(
    formatProjectMemoryInspection(inspection),
    /confirmed rules 0 · needs confirmation 0/,
  );
  assert.match(formatProjectMemoryInspection(inspection), /pending 1 items\/\d+ bytes/);
  assert.match(
    formatProjectMemoryInspection(inspection),
    /Bootstrap: not_required · active working 1 · estimated model attempts 0 · selected conversations 0/,
  );
});

test("memory inspection still reports repository state when memory is disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-memory-inspect-disabled-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const memory: MemoryClient = {
    enabled: false,
    async bootstrapProjectContext() {
      throw new Error("should not be called");
    },
    async call() {
      throw new Error("should not be called");
    },
  };

  const inspection = await inspectProjectMemory({
    projectName: "PlainProject",
    projectPath: root,
    memory,
    byteBudget: 12_288,
  });
  assert.equal(inspection.memory.enabled, false);
  assert.match(formatProjectMemoryInspection(inspection), /Memory: disabled/);
});

test("memory inspect project resolution discovers nested git repos and rejects ambiguity", async (t) => {
  const allowedRoot = await mkdtemp(join(tmpdir(), "devspace-memory-discovery-"));
  t.after(async () => rm(allowedRoot, { recursive: true, force: true }));
  const first = join(allowedRoot, "Swift", "LEMonX");
  await mkdir(first, { recursive: true });
  await git(first, ["init"]);
  const registry = new ProjectRegistry(join(allowedRoot, "projects.json"), [allowedRoot]);

  const discovered = resolveMemoryInspectionProject("lemonx", registry, [allowedRoot]);
  assert.equal(discovered.name, "LEMonX");
  assert.equal(discovered.path, await realpath(first));

  const second = join(allowedRoot, "Archived", "LEMonX");
  await mkdir(second, { recursive: true });
  await git(second, ["init"]);
  assert.throws(
    () => resolveMemoryInspectionProject("LEMonX", registry, [allowedRoot]),
    /ambiguous/,
  );
});

function fakeMemory(): MemoryClient {
  const bootstrap: MemoryBootstrapContext = {
    project: "LEMonX",
    sourcePolicy: "relevance-filter",
    bootstrapStatus: {
      state: "not_required",
      activeWorkingMemoryItems: 1,
      estimatedModelAttempts: 0,
      selectedConversations: 0,
      skipReason: "active_working_memory_exists",
    },
    collaborationMemory: { items: [] },
    workingMemory: {
      project: "LEMonX",
      items: [{
        memoryId: "current-goal",
        kind: "state",
        key: "current_goal",
        value: { text: "Complete repository acceptance." },
        importance: 95,
        confidence: 1,
        lastVerifiedAt: 0,
        evidence: [{
          kind: "conversation_turn",
          reference: "conversation:test:message:a1",
        }],
      }],
      verification: [{
        memoryId: "current-goal",
        class: "operational",
        evidenceStrength: "conversation_only",
        sourceState: "current_by_evidence",
      }],
      confirmation: [{
        memoryId: "current-goal",
        state: "not_applicable",
      }],
    },
    pendingMemory: {
      project: "LEMonX",
      items: [{
        candidateId: "pending-next-step",
        operation: "resolve",
        payload: { type: "resolve", targetMemoryId: "old-blocker" },
        createdAt: 2,
        conversationId: "private-pending-conversation",
        sourceSnapshotId: "private-pending-snapshot",
        throughTurnIndex: 3,
      }],
      revalidationExcludedCount: 0,
    },
    continuations: [],
    relevant: [],
    recent: [],
    truncated: false,
    byteBudget: 12_288,
  };
  return {
    enabled: true,
    async bootstrapProjectContext() {
      return bootstrap;
    },
    async call(toolName) {
      assert.equal(toolName, "memory_health");
      return {
        content: [],
        structuredContent: {
          project: "LEMonX",
          memory_items: { active: 1 },
          candidates: { pending: 0 },
          checkpoint_count: 1,
          incomplete_canonical_conversation_count: 0,
        },
        isError: false,
      };
    },
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
