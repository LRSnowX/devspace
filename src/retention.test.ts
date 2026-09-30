import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { Result as BetterResult } from "better-result";
import { databasePath } from "./db/client.js";
import {
  DEFAULT_WORKSPACE_METADATA_RETENTION_MS,
  inspectWorkspaceMetadataRetention,
  pruneWorkspaceMetadataRetention,
} from "./retention.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("workspace metadata retention prunes only safe stale metadata and matching review refs", async (t) => {
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
  store.createSession({
    id: "ws_disposable",
    root: join(root, "managed-pruned-disposable"),
    mode: "worktree",
    sourceRoot: staleProject,
    baseSha: git(staleProject, ["rev-parse", "HEAD"]).trim(),
    managed: true,
  });
  store.createSession({
    id: "ws_recoverable",
    root: join(root, "managed-pruned-recoverable"),
    mode: "worktree",
    sourceRoot: staleProject,
    baseSha: git(staleProject, ["rev-parse", "HEAD"]).trim(),
    managed: true,
  });
  store.createSession({
    id: "ws_hidden_ref",
    root: join(root, "managed-pruned-hidden-ref"),
    mode: "worktree",
    sourceRoot: staleProject,
    baseSha: git(staleProject, ["rev-parse", "HEAD"]).trim(),
    managed: true,
  });
  unwrapStore(store.markSessionPruned("ws_disposable"));
  unwrapStore(store.markSessionPruned("ws_recoverable", "head"));
  unwrapStore(store.markSessionPruned("ws_hidden_ref"));
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
  const staleAt = new Date(now.getTime() - DEFAULT_WORKSPACE_METADATA_RETENTION_MS - 1).toISOString();
  const sqlite = new Database(databasePath(stateDir));
  sqlite.prepare(
    "update workspace_sessions set last_used_at = ? where id in ('ws_stale', 'ws_protected', 'ws_worktree', 'ws_disposable', 'ws_recoverable', 'ws_hidden_ref')",
  ).run(staleAt);
  sqlite.prepare(
    "update workspace_conversation_bindings set last_used_at = ? where workspace_session_id in ('ws_stale', 'ws_protected')",
  ).run(staleAt);
  sqlite.close();

  const head = git(staleProject, ["rev-parse", "HEAD"]).trim();
  git(staleProject, ["update-ref", "refs/devspace/review/ws_stale/open", head]);
  git(staleProject, ["update-ref", "refs/devspace/review/ws_stale/baseline", head]);
  git(staleProject, ["update-ref", "refs/devspace/review/ws_disposable/open", head]);
  git(staleProject, ["update-ref", "refs/devspace/review/ws_disposable/baseline", head]);
  git(staleProject, ["update-ref", "refs/devspace/recovery/ws_hidden_ref", head]);

  const protectedRoot = await realpath(protectedProject);
  const config = { stateDir, allowedRoots: [root] };
  const inspected = await inspectWorkspaceMetadataRetention(
    config,
    now,
    new Set([protectedRoot]),
  );
  assert.equal(inspected.isErr(), false);
  if (inspected.isErr()) throw inspected.error;
  assert.deepEqual(
    inspected.value.eligible.map((entry) => [entry.workspaceId, entry.kind]),
    [
      ["ws_stale", "stale_checkout"],
      ["ws_disposable", "disposable_pruned_worktree"],
    ],
  );
  assert.deepEqual(inspected.value.skipped, [
    {
      workspaceId: "ws_protected",
      root: protectedProject,
      reason: "patch_recovery_required",
    },
    {
      workspaceId: "ws_recoverable",
      root: join(root, "managed-pruned-recoverable"),
      reason: "recovery_metadata_present",
    },
    {
      workspaceId: "ws_hidden_ref",
      root: join(root, "managed-pruned-hidden-ref"),
      reason: "recovery_ref_present",
    },
  ]);

  const pruned = await pruneWorkspaceMetadataRetention(
    config,
    now,
    new Set([protectedRoot]),
  );
  assert.equal(pruned.isErr(), false);
  if (pruned.isErr()) throw pruned.error;
  assert.deepEqual(pruned.value.pruned, ["ws_stale", "ws_disposable"]);
  assert.deepEqual(pruned.value.stateChanged, []);
  assert.equal(pruned.value.reviewRefsDeleted, 4);
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
  assert.equal(after.getSession("ws_disposable"), undefined);
  assert.ok(after.getSession("ws_recoverable"));
  assert.ok(after.getSession("ws_hidden_ref"));
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
  assert.throws(() => git(staleProject, [
    "show-ref",
    "--verify",
    "refs/devspace/review/ws_disposable/open",
  ]));
  assert.throws(() => git(staleProject, [
    "show-ref",
    "--verify",
    "refs/devspace/review/ws_disposable/baseline",
  ]));
  assert.match(
    git(staleProject, ["show-ref", "--verify", "refs/devspace/recovery/ws_hidden_ref"]),
    /refs\/devspace\/recovery\/ws_hidden_ref/,
  );
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

function unwrapStore<T, E>(result: BetterResult<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}
