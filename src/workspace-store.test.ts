import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Result as BetterResult } from "better-result";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("workspace store lists only stale managed worktrees", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const managed = store.createSession({
    id: "ws_managed",
    root: "/tmp/managed",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: true,
  });
  store.createSession({
    id: "ws_checkout",
    root: "/tmp/repo",
    mode: "checkout",
  });
  store.createSession({
    id: "ws_unmanaged",
    root: "/tmp/unmanaged",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: false,
  });

  assert.deepEqual(
    unwrap(store.listStaleManagedWorktrees(new Date(Date.now() + 60_000))).map((session) => session.id),
    [managed.id],
  );
  assert.deepEqual(unwrap(store.listStaleManagedWorktrees(new Date(0))), []);
});

test("workspace store lists only stale active checkout sessions", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const checkout = store.createSession({
    id: "ws_checkout",
    root: "/tmp/repo",
  });
  store.createSession({
    id: "ws_worktree",
    root: "/tmp/worktree",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: true,
  });

  assert.deepEqual(
    unwrap(store.listStaleCheckoutSessions(new Date(Date.now() + 60_000)))
      .map((session) => session.id),
    [checkout.id],
  );
  assert.deepEqual(unwrap(store.listStaleCheckoutSessions(new Date(0))), []);
});

test("workspace store lists stale pruned managed worktrees regardless of recovery kind", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  store.createSession({
    id: "ws_plain",
    root: "/tmp/worktree-plain",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: true,
  });
  store.createSession({
    id: "ws_recoverable",
    root: "/tmp/worktree-recoverable",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: true,
  });
  unwrap(store.markSessionPruned("ws_plain"));
  unwrap(store.markSessionPruned("ws_recoverable", "head"));

  assert.deepEqual(
    unwrap(store.listStalePrunedManagedWorktrees(new Date(Date.now() + 60_000)))
      .map((session) => [session.id, session.recoveryKind] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ["ws_plain", undefined],
      ["ws_recoverable", "head"],
    ],
  );
  assert.deepEqual(unwrap(store.listStalePrunedManagedWorktrees(new Date(0))), []);
});

test("retention deletes recheck workspace state atomically", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  store.createSession({ id: "ws_checkout", root: "/tmp/repo" });
  store.createSession({
    id: "ws_pruned",
    root: "/tmp/worktree",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: true,
  });
  unwrap(store.markSessionPruned("ws_pruned"));

  const future = new Date(Date.now() + 60_000);
  assert.equal(unwrap(store.deleteStaleCheckoutSession("ws_checkout", future)), true);
  assert.equal(store.getSession("ws_checkout"), undefined);

  assert.equal(unwrap(store.reactivateSession("ws_pruned")), true);
  assert.equal(
    unwrap(store.deleteDisposablePrunedWorktreeSession("ws_pruned", future)),
    false,
  );
  assert.equal(store.getSession("ws_pruned")?.status, "active");
});

test("pruned worktree sessions retain recovery state and can be reactivated", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  store.createSession({
    id: "ws_recoverable",
    root: "/tmp/worktree",
    mode: "worktree",
    sourceRoot: "/tmp/repo",
    managed: true,
  });

  unwrap(store.markSessionPruned("ws_recoverable", "stash"));
  assert.equal(store.getSession("ws_recoverable")?.status, "pruned");
  assert.equal(store.getSession("ws_recoverable")?.recoveryKind, "stash");
  assert.equal(unwrap(store.touchSession("ws_recoverable")), false);

  assert.equal(unwrap(store.reactivateSession("ws_recoverable")), true);
  assert.equal(store.getSession("ws_recoverable")?.status, "active");
  assert.equal(store.getSession("ws_recoverable")?.recoveryKind, undefined);
});

function unwrap<T, E>(result: BetterResult<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}
