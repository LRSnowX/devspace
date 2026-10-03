import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WriteOwnership, WriteOwnershipError } from "./write-ownership.js";
import { writeOwnershipPaths } from "./write-ownership-store.js";
import { startOwnershipChild } from "./test-support/ownership-process-fixture.js";

test(
  "real retention-process SIGKILL during partial deletion preserves guard and destructive-child evidence",
  { skip: process.platform === "win32" },
  async (t) => {
    const base = realpathSync(
      mkdtempSync(join(tmpdir(), "ds-retention-crash-")),
    );
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const source = join(base, "source");
    mkdirSync(source);
    const worktreeRoot = join(base, "worktrees");
    mkdirSync(worktreeRoot);
    const root = join(worktreeRoot, "ws_crash");
    const stateDir = join(base, "state");
    const actualGit = execFileSync("which", ["git"], {
      encoding: "utf8",
    }).trim();
    const git = (args: string[]) =>
      execFileSync(actualGit, args, { cwd: source, encoding: "utf8" }).trim();
    git(["init"]);
    git(["config", "user.email", "fixture@example.com"]);
    git(["config", "user.name", "Fixture"]);
    writeFileSync(join(source, "README.md"), "original");
    git(["add", "."]);
    git(["commit", "-m", "fixture"]);
    git(["worktree", "add", "--detach", root, "HEAD"]);
    const store = new SqliteWorkspaceStore(stateDir);
    store.createSession({
      id: "ws_crash",
      root,
      mode: "worktree",
      managed: true,
      sourceRoot: source,
      baseSha: git(["rev-parse", "HEAD"]),
    });
    store.close();
    const bin = join(base, "bin");
    mkdirSync(bin);
    const marker = join(base, "destructive-executor");
    // Deterministic Git-edge fixture: perform a real partial filesystem deletion,
    // then keep the destructive child alive while its parent is killed.
    writeFileSync(
      join(bin, "git"),
      `#!${process.execPath}\nconst fs = require('node:fs');
const cp = require('node:child_process'); const args = process.argv.slice(2);
if (args[0] === 'worktree' && args[1] === 'remove') {
  fs.unlinkSync(require('node:path').join(process.env.FIXTURE_ROOT, 'README.md'));
  fs.writeFileSync(process.env.FIXTURE_MARKER, String(process.pid));
  setInterval(() => {}, 1000);
} else { const result = cp.spawnSync(process.env.FIXTURE_REAL_GIT, args, { stdio: 'inherit' }); process.exit(result.status ?? 1); }
`,
      { mode: 0o700 },
    );
    const child = await startOwnershipChild(t, "cleanup", stateDir, root, {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FIXTURE_ROOT: root,
      FIXTURE_MARKER: marker,
      FIXTURE_REAL_GIT: actualGit,
    });
    child.send("go");
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(marker), true);
    const executor = Number(readFileSync(marker, "utf8"));
    t.after(() => {
      try {
        process.kill(executor, "SIGKILL");
      } catch {}
    });
    const ownership = new WriteOwnership(stateDir);
    const paths = writeOwnershipPaths(stateDir, root);
    assert.equal(existsSync(paths.mutex), false);
    assert.ok(
      ownership
        .diagnostics(root)
        .retention?.executor_processes.includes(executor),
    );
    child.kill("SIGKILL");
    await once(child, "exit");
    assert.equal(existsSync(join(root, "README.md")), false);
    assert.equal(existsSync(paths.retention), true);
    assert.throws(
      () => ownership.recover(root, () => true),
      (error) =>
        error instanceof WriteOwnershipError &&
        error.code === "WRITE_OWNERSHIP_BUSY",
    );
    assert.throws(
      () => ownership.acquire(root, "ws_other"),
      (error) =>
        error instanceof WriteOwnershipError &&
        error.code === "WRITE_OWNERSHIP_BUSY",
    );
    const unrelated = join(base, "unrelated");
    mkdirSync(unrelated);
    assert.equal(ownership.acquire(unrelated, "ws_other").status, "acquired");
    process.kill(executor, "SIGKILL");
    assert.throws(
      () => new WriteOwnership(stateDir).recover(root, () => false),
      WriteOwnershipError,
    );
    assert.equal(existsSync(paths.retention), true);
  },
);
