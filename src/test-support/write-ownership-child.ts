// Filesystem/daemon fixtures only: never invokes a model or provider executable.
import { Result } from "better-result";
import { dirname } from "node:path";
import { cleanupManagedWorktrees } from "../git-worktrees.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WriteOwnership } from "../write-ownership.js";
import { LocalAgentManager } from "../local-agent-manager.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { LocalAgentRuntimePool } from "../local-agent-runtime-pool.js";
import { LocalAgentDaemon } from "../local-agent-daemon.js";
import {
  AgentProviderCancelledError,
  AgentProviderExecutionError,
} from "../local-agent-errors.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRuntime,
} from "../local-agent-runtime.js";

const [role, stateDir, root] = process.argv.slice(2) as [
  string,
  string,
  string,
];
const ownership = new WriteOwnership(stateDir);
const send = (value: unknown) => process.send?.(value);
if (role === "daemon") {
  const releases = new Set<() => void>();
  class FixtureRuntime implements LocalAgentRuntime {
    provider = "codex" as const;
    executorEvidence() {
      return { processIds: [process.pid], complete: true };
    }
    async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
      if (input.prompt === "hold")
        await new Promise<void>((resolve) => {
          releases.add(resolve);
          send({ entered: true });
        });
      if (input.prompt === "ambiguous")
        return Result.err(
          new AgentProviderExecutionError({
            code: "PROVIDER_EXECUTION_ERROR",
            provider: this.provider,
            operation: "run",
            retryable: false,
            message: "Transport disappeared",
          }),
        );
      callbacks?.onTurnTerminal?.();
      if (input.prompt === "cancel")
        return Result.err(
          new AgentProviderCancelledError({
            code: "PROVIDER_CANCELLED",
            provider: this.provider,
            operation: "run",
            retryable: false,
            message: "Acknowledged cancellation",
          }),
        );
      if (input.prompt === "fail")
        return Result.err(
          new AgentProviderExecutionError({
            code: "PROVIDER_EXECUTION_ERROR",
            provider: this.provider,
            operation: "run",
            retryable: false,
            message: "Terminal provider error",
          }),
        );
      return Result.ok({
        provider: this.provider,
        providerSessionId: null,
        finalResponse: "done",
        items: [],
      });
    }
    isAlive() {
      return true;
    }
    async close() {
      for (const release of releases) release();
      releases.clear();
    }
    async releaseSession() {}
  }
  const driver: LocalAgentDriver = {
    provider: "codex",
    runtimeKey: (context) => context.agentId,
    createRuntime: async () => Result.ok(new FixtureRuntime()),
  };
  const manager = new LocalAgentManager({
    store: new LocalAgentStore(stateDir),
    writeOwnership: ownership,
    drivers: [driver],
    pool: new LocalAgentRuntimePool(),
    loadProfiles: async () => [],
    allowedRoots: [root],
    subagents: {
      enabled: true,
      instructions: "on-demand",
      providers: [{ id: "codex", enabled: true }],
    },
  });
  const daemon = new LocalAgentDaemon({
    stateDir,
    configRevision: "ownership-fixture",
    manager,
    idleShutdownMs: 60_000,
    onLockAcquired: () => {
      const result = manager.reconcileActiveRuns();
      if (result.isErr()) throw result.error;
    },
  });
  await daemon.start();
  process.on("message", async (message) => {
    if (message === "release") {
      for (const release of releases) release();
      releases.clear();
      send({ released: true });
    }
    if (message === "stop") {
      await daemon.close();
      process.exit(0);
    }
  });
  send({ ready: true });
} else if (role === "cleanup") {
  process.on("message", async (message) => {
    if (message !== "go") return;
    const store = new SqliteWorkspaceStore(stateDir);
    try {
      const result = await cleanupManagedWorktrees({
        store,
        writeOwnership: ownership,
        worktreeRoot: dirname(root),
        allowedRoots: [dirname(dirname(root))],
        staleBefore: new Date(Date.now() + 60_000),
      });
      send({ finished: true, failed: result.isErr() });
    } finally {
      store.close();
    }
  });
  send({ ready: true });
} else {
  process.on("message", (message) => {
    if (message !== "go") return;
    try {
      if (role === "acquire") ownership.acquire(root, "ws_racer");
      else
        ownership.beginDestructiveRetention(root, "managed_worktree", {
          processIds: [process.pid],
          complete: role === "complete-retention",
        });
      send({ ok: true });
    } catch (error) {
      send({ ok: false, code: (error as { code?: string }).code });
    }
  });
  send({ ready: true });
}
