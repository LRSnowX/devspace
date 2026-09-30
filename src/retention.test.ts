import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { databasePath } from "./db/client.js";
import {
  DEFAULT_CHECKOUT_SESSION_RETENTION_MS,
  inspectCheckoutRetention,
  pruneCheckoutRetention,
} from "./retention.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("checkout retention prunes only stale checkout metadata and matching review refs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-retention-test-"));
  const stateDir = join(root, "state");
  const staleProject = join(root, "stale-project");
  const protectedProject = join(root, "protected-project");
  const recentProject = join(root, "recent-project");
  await Promise.all([
    initGit(staleProject),
    initGit(protectedProject),
    initGit(recentProject),
  ]);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const store = new SqliteWorkspaceStore(stateDir);
  store.createSession({ id: "ws_stale", root: staleProject });
  store.createSession({ id: "ws_protected", root: protectedProject });
  store.createSession({ id: "ws_recent", root: recentProject });
  store.createSession({
    id: "ws_worktree",
    root: join(root, "managed-worktree"),
    mode: "worktree",
    sourceRoot: staleProject,
    managed: true,
  });
  store.setConversationBinding({
    conversationScopeId: "conversation-stale",
    targetKey: staleProject,
    workspaceSessionId: "ws_stale",
  });
  store.setConversationBinding({
    conversationScopeId: "conversation-protected",
    targetKey: protectedProject,
    workspaceSessionId: "ws_protected",
  });
  store.close();

  const now = new Date("2026-09-30T12:00:00.000Z");
  const staleAt = new Date(now.getTime() - DEFAULT_CHECKOUT_SESSION_RETENTION_MS - 1).toISOString();
  const sqlite = new Database(databasePath(stateDir));
  sqlite.prepare(
    "update workspace_sessions set last_used_at = ? where id in ('ws_stale', 'ws_protected', 'ws_worktree')",
  ).run(staleAt);
  sqlite.prepare(
    "update workspace_conversation_bindings set last_used_at = ? where workspace_session_id in ('ws_stale', 'ws_protected')",
  ).run(staleAt);
  sqlite.close();

  const head = git(staleProject, ["rev-parse", "HEAD"]).trim();
  git(staleProject, ["update-ref", "refs/devspace/review/ws_stale/open", head]);
  git(staleProject, ["update-ref", "refs/devspace/review/ws_stale/baseline", head]);

  const protectedRoot = await realpath(protectedProject);
  const config = { stateDir, allowedRoots: [root] };
  const inspected = await inspectCheckoutRetention(
    config,
    now,
    new Set([protectedRoot]),
  );
  assert.equal(inspected.isErr(), false);
  if (inspected.isErr()) throw inspected.error;
  assert.deepEqual(inspected.value.eligible.map((entry) => entry.workspaceId), ["ws_stale"]);
  assert.deepEqual(inspected.value.skipped, [{
    workspaceId: "ws_protected",
    root: protectedProject,
    reason: "patch_recovery_required",
  }]);

  const pruned = await pruneCheckoutRetention(
    config,
    now,
    new Set([protectedRoot]),
  );
  assert.equal(pruned.isErr(), false);
  if (pruned.isErr()) throw pruned.error;
  assert.deepEqual(pruned.value.pruned, ["ws_stale"]);
  assert.equal(pruned.value.reviewRefsDeleted, 2);
  assert.deepEqual(pruned.value.failed, []);
  assert.deepEqual(pruned.value.reviewCleanupFailed, []);

  const after = new SqliteWorkspaceStore(stateDir);
  assert.equal(after.getSession("ws_stale"), undefined);
  assert.equal(
    after.getConversationBinding("conversation-stale", staleProject),
    undefined,
  );
  assert.ok(after.getSession("ws_protected"));
  assert.ok(after.getSession("ws_recent"));
  assert.ok(after.getSession("ws_worktree"));
  assert.ok(
    after.getConversationBinding("conversation-protected", protectedProject),
  );
  after.close();

  assert.throws(() => git(staleProject, [
    "show-ref",
    "--verify",
    "refs/devspace/review/ws_stale/open",
  ]));
  assert.throws(() => git(staleProject, [
    "show-ref",
    "--verify",
    "refs/devspace/review/ws_stale/baseline",
  ]));
});

async function initGit(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.email", "devspace@test.local"]);
  git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "test\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
