import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";
import { DEFAULT_WORKSPACE_METADATA_RETENTION_MS } from "./retention.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

test("retention CLI inspects and explicitly prunes safe stale workspace metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-cli-retention-test-"));
  try {
    const stateDir = join(root, "state");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const env = {
      ...process.env,
      ...writeTestDevspaceConfig(join(root, "config"), {
        storage: { stateDir },
        workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
      }),
    };

    const store = new SqliteWorkspaceStore(stateDir);
    store.createSession({ id: "ws_stale", root: project });
    store.setConversationBinding({
      conversationScopeId: "chat-stale",
      targetKey: project,
      workspaceSessionId: "ws_stale",
    });
    store.close();

    const staleAt = new Date(
      Date.now() - DEFAULT_WORKSPACE_METADATA_RETENTION_MS - 60_000,
    ).toISOString();
    const sqlite = new Database(databasePath(stateDir));
    sqlite.prepare(
      "update workspace_sessions set last_used_at = ? where id = 'ws_stale'",
    ).run(staleAt);
    sqlite.close();

    const inspected = JSON.parse(runCli(["retention", "inspect", "--json"], env)) as {
      eligible: Array<{ workspaceId: string }>;
    };
    assert.deepEqual(inspected.eligible.map((entry) => entry.workspaceId), ["ws_stale"]);

    const pruned = JSON.parse(runCli(["retention", "prune", "--json"], env)) as {
      pruned: string[];
      failed: unknown[];
    };
    assert.deepEqual(pruned.pruned, ["ws_stale"]);
    assert.deepEqual(pruned.failed, []);

    const after = new SqliteWorkspaceStore(stateDir);
    assert.equal(after.getSession("ws_stale"), undefined);
    assert.equal(after.getConversationBinding("chat-stale", project), undefined);
    after.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    encoding: "utf8",
    env,
  });
}
