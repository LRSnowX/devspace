import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { openDatabase } from "./db/client.js";
import { PatchRecoveryManager } from "./patch-recovery.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

test("worktrees prune removes only managed worktrees unused for three days", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-cli-worktree-test-"));
  const sourceRoot = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  const oldWorktree = join(worktreeRoot, "old");
  const recentWorktree = join(worktreeRoot, "recent");
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  await mkdir(sourceRoot);
  await mkdir(worktreeRoot);
  await writeFile(join(sourceRoot, "README.md"), "initial\n");
  await git(sourceRoot, ["init"]);
  await git(sourceRoot, ["config", "user.email", "devspace@example.com"]);
  await git(sourceRoot, ["config", "user.name", "DevSpace Test"]);
  await git(sourceRoot, ["add", "."]);
  await git(sourceRoot, ["commit", "-m", "Initial commit"]);
  await git(sourceRoot, ["worktree", "add", "--detach", oldWorktree, "HEAD"]);
  await git(sourceRoot, ["worktree", "add", "--detach", recentWorktree, "HEAD"]);

  const baseSha = await git(sourceRoot, ["rev-parse", "HEAD"]);
  const store = new SqliteWorkspaceStore(stateDir);
  store.createSession({
    id: "ws_old",
    root: oldWorktree,
    mode: "worktree",
    sourceRoot,
    baseSha,
    managed: true,
  });
  store.createSession({
    id: "ws_recent",
    root: recentWorktree,
    mode: "worktree",
    sourceRoot,
    baseSha,
    managed: true,
  });
  store.close();

  const database = openDatabase(stateDir);
  database.sqlite
    .prepare("update workspace_sessions set last_used_at = ? where id = 'ws_old'")
    .run(new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString());
  database.close();

  const env = writeTestDevspaceConfig(configDir, {
    workspaces: { allowedRoots: [sourceRoot], worktreeRoot },
    storage: { stateDir },
  });

  t.after(async () => {
    await git(sourceRoot, ["worktree", "remove", "--force", oldWorktree]).catch(() => undefined);
    await git(sourceRoot, ["worktree", "remove", "--force", recentWorktree]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", cliPath, "worktrees", "prune"],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );

  assert.match(stdout, /Pruned 1 stale managed worktree\./);
  assert.equal(await pathExists(oldWorktree), false);
  assert.equal(await pathExists(recentWorktree), true);
});

test("worktrees prune preserves a stale worktree pending patch recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-cli-worktree-recovery-test-"));
  const sourceRoot = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  const oldWorktree = join(worktreeRoot, "old");
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  await mkdir(sourceRoot);
  await mkdir(worktreeRoot);
  await writeFile(join(sourceRoot, "README.md"), "initial\n");
  await git(sourceRoot, ["init"]);
  await git(sourceRoot, ["config", "user.email", "devspace@example.com"]);
  await git(sourceRoot, ["config", "user.name", "DevSpace Test"]);
  await git(sourceRoot, ["add", "."]);
  await git(sourceRoot, ["commit", "-m", "Initial commit"]);
  await git(sourceRoot, ["worktree", "add", "--detach", oldWorktree, "HEAD"]);

  const baseSha = await git(sourceRoot, ["rev-parse", "HEAD"]);
  const store = new SqliteWorkspaceStore(stateDir);
  store.createSession({
    id: "ws_recovery",
    root: oldWorktree,
    mode: "worktree",
    sourceRoot,
    baseSha,
    managed: true,
  });
  store.close();

  const database = openDatabase(stateDir);
  database.sqlite
    .prepare("update workspace_sessions set last_used_at = ? where id = 'ws_recovery'")
    .run(new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString());
  database.close();

  const recovery = new PatchRecoveryManager(stateDir);
  const transactionId = "c22095c0-5b60-4ccd-8d18-b4fab6757626";
  recovery.createPreparing({
    id: transactionId,
    root: await realpath(oldWorktree),
    files: [{
      path: "README.md",
      original: { kind: "absent" },
      published: { kind: "absent" },
    }],
  });
  recovery.markRecoveryRequired(transactionId, "manual inspection required");
  recovery.close();

  const env = writeTestDevspaceConfig(configDir, {
    workspaces: { allowedRoots: [sourceRoot], worktreeRoot },
    storage: { stateDir },
  });

  t.after(async () => {
    await git(sourceRoot, ["worktree", "remove", "--force", oldWorktree]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", cliPath, "worktrees", "prune"],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );

  assert.match(stdout, /Pruned 0 stale managed worktrees\./);
  assert.match(stdout, /Skipped 1 worktree pending patch recovery\./);
  assert.equal(await pathExists(oldWorktree), true);
  const verifyStore = new SqliteWorkspaceStore(stateDir);
  assert.ok(verifyStore.getSession("ws_recovery"));
  verifyStore.close();
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
