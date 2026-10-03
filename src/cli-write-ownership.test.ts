import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { WriteOwnership } from "./write-ownership.js";
import { writeOwnershipPaths } from "./write-ownership-store.js";

test("operator CLI lists/shows aliases, recovers idle state and refuses live/incomplete/corrupt state", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ds-owner-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(project);
  const stateDir = join(root, "state");
  const env = {
    ...process.env,
    ...writeTestDevspaceConfig(join(root, "config"), {
      storage: { stateDir },
      workspaces: {
        allowedRoots: [root],
        worktreeRoot: join(root, "worktrees"),
      },
    }),
  };
  const cli = (args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", ...args],
        { env, encoding: "utf8", timeout: 15_000 },
      ),
    );
  cli(["projects", "register", "Project", project, "--alias", "Alias"]);
  const ownership = new WriteOwnership(stateDir);
  ownership.acquire(project, "ws_owner");
  assert.equal(
    cli(["write-ownership", "show", "Alias"]).ownership.owner_workspace_id,
    "ws_owner",
  );
  assert.equal(cli(["write-ownership", "list"]).roots.length, 1);
  assert.equal(
    cli(["write-ownership", "recover", project]).status,
    "recovered",
  );
  ownership.acquire(project, "ws_owner");
  const activity = ownership.beginMutation(
    project,
    "ws_owner",
    "subagent_turn",
    { processIds: [process.pid], complete: true },
  );
  assert.throws(
    () => cli(["write-ownership", "recover", "Project"]),
    /still alive/,
  );
  ownership.endMutation(activity);
  ownership.release(project, "ws_owner");
  const guard = ownership.beginDestructiveRetention(
    project,
    "managed_worktree",
  );
  assert.equal(
    cli(["write-ownership", "show", project]).retention.guard_id,
    guard.guardId,
  );
  assert.throws(
    () => cli(["write-ownership", "recover", project]),
    /still alive/,
  );
  ownership.endDestructiveRetention(guard);
  ownership.acquire(project, "ws_owner");
  const paths = writeOwnershipPaths(stateDir, project);
  writeFileSync(paths.state, "{");
  assert.ok(cli(["write-ownership", "list"]).errors.length);
  assert.throws(
    () => cli(["write-ownership", "recover", project]),
    /Undecodable/,
  );
  assert.equal(readFileSync(paths.state, "utf8"), "{");
  assert.throws(
    () => cli(["write-ownership", "show", "/outside-configured-roots"]),
    /outside allowed roots/,
  );
  assert.throws(
    () => cli(["write-ownership", "recover", project, "--force-active"]),
    /Usage/,
  );
});

test("metadata guard recovery requires a dead exhaustive executor and unchanged filesystem identity", (t) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ds-owner-cli-recover-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const project = join(root, "project");
  mkdirSync(project);
  const env = {
    ...process.env,
    ...writeTestDevspaceConfig(join(root, "config"), {
      storage: { stateDir },
      workspaces: {
        allowedRoots: [root],
        worktreeRoot: join(root, "worktrees"),
      },
    }),
  };
  const cli = () =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "write-ownership", "recover", project],
      { env, encoding: "utf8", timeout: 15_000 },
    );
  // A real exited process supplies unambiguous PID evidence without a mock
  // liveness probe in the operator CLI process.
  const deadPid = Number(
    execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      { encoding: "utf8" },
    ),
  );
  const ownership = new WriteOwnership(stateDir);
  ownership.beginDestructiveRetention(project, "workspace_metadata", {
    processIds: [deadPid],
    complete: true,
  });
  assert.equal(JSON.parse(cli()).status, "recovered");
  ownership.beginDestructiveRetention(project, "workspace_metadata", {
    processIds: [deadPid],
    complete: true,
  });
  renameSync(project, join(root, "original"));
  mkdirSync(project);
  assert.throws(cli, /filesystem lifecycle is ambiguous/);
  assert.ok(ownership.diagnostics(project).retention);
});
