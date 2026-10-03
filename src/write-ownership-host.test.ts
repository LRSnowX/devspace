import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessSessionManager } from "./process-sessions.js";
import { WriteOwnership, WriteOwnershipError } from "./write-ownership.js";
import {
  beginOwnedProcess,
  ownershipSnapshot,
  withOwnedMutation,
  withOwnedShellCall,
} from "./write-ownership-host.js";
import { ownedBashOperations } from "./owned-bash.js";
import { toolErrorPayload } from "./tool-errors.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "devspace-ownership-host-"));
  const root = await realpath(directory);
  const stateDir = join(root, "state");
  const ownership = new WriteOwnership(stateDir);
  const processes = new ProcessSessionManager();
  t.after(async () => {
    await processes.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  ownership.acquire(root, "ws_owner");
  return { root, stateDir, ownership, processes };
}

test("file activity finally cleanup retains the claim on thrown failure and supports multiple activities", async (t) => {
  const { root, ownership, stateDir } = await fixture(t);
  const other = ownership.beginMutation(root, "ws_owner", "write");
  await assert.rejects(
    withOwnedMutation(ownership, root, "ws_owner", "edit", async () => {
      const records = ownership.inspect(root, "ws_owner").activeMutations;
      assert.equal(records.length, 2);
      const activity = records.find((record) => record.kind === "edit")!;
      assert.deepEqual(activity.executor_processes, [process.pid]);
      assert.equal(activity.executor_processes_complete, true);
      throw new Error("mutation failed");
    }),
    /mutation failed/,
  );
  assert.equal(
    ownership.inspect(root, "ws_owner").activeMutations[0]?.activity_id,
    other.activityId,
  );
  ownership.endMutation(other);
  assert.deepEqual(
    ownershipSnapshot(new WriteOwnership(stateDir), root, "ws_owner"),
    {
      state: "owned_by_workspace",
      owner_workspace_id: "ws_owner",
      active_mutation_count: 0,
    },
  );
});

test("failed pipe start and failed Bash start end their exact activity", async (t) => {
  const { root, ownership, processes } = await fixture(t);
  const input = {
    workspaceId: "ws_owner",
    cwd: join(root, "missing"),
    command: "echo never",
    yieldTimeMs: 2000,
    mutation: () => beginOwnedProcess(ownership, root, "ws_owner"),
  };
  assert.equal((await processes.start(input)).running, false);
  assert.equal(
    ownershipSnapshot(ownership, root, "ws_owner").active_mutation_count,
    0,
  );
  await assert.rejects(processes.start({ ...input, cwd: root, command: "\0" }));
  assert.equal(
    ownershipSnapshot(ownership, root, "ws_owner").active_mutation_count,
    0,
  );
  const bash = ownedBashOperations(() =>
    beginOwnedProcess(ownership, root, "ws_owner"),
  );
  await assert.rejects(bash.exec("echo never", input.cwd, { onData() {} }));
  assert.equal(
    ownershipSnapshot(ownership, root, "ws_owner").active_mutation_count,
    0,
  );
  if (process.platform !== "win32") {
    const failedPty = await processes.start({ ...input, tty: true });
    assert.equal(failedPty.running, false);
    assert.equal(
      ownershipSnapshot(ownership, root, "ws_owner").active_mutation_count,
      0,
    );
  }
});

test("shutdown signals are not activity cleanup until the actual process exits", async (t) => {
  const { root, ownership, processes } = await fixture(t);
  const processResult = await processes.start({
    workspaceId: "ws_owner",
    cwd: root,
    command: `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`,
    yieldTimeMs: 5,
    mutation: () => beginOwnedProcess(ownership, root, "ws_owner"),
  });
  assert.equal(processResult.running, true);
  const shuttingDown = processes.shutdown();
  assert.equal(
    ownershipSnapshot(ownership, root, "ws_owner").active_mutation_count,
    1,
  );
  await shuttingDown;
  assert.equal(
    ownershipSnapshot(ownership, root, "ws_owner").active_mutation_count,
    0,
  );
  assert.equal(ownership.release(root, "ws_owner").status, "released");
});

test("synchronous shell activity covers result handling after executor completion", async (t) => {
  const { root, ownership } = await fixture(t);
  await withOwnedShellCall(ownership, root, "ws_owner", async (executor) => {
    const bash = ownedBashOperations(() => executor);
    assert.equal(
      (await bash.exec("echo finished", root, { onData() {} })).exitCode,
      0,
    );
    assert.equal(
      ownershipSnapshot(ownership, root, "ws_owner").active_mutation_count,
      1,
    );
    await Promise.resolve();
    assert.throws(() => ownership.release(root, "ws_owner"), {
      code: "WRITE_OWNERSHIP_BUSY",
    });
  });
  assert.equal(
    ownershipSnapshot(ownership, root, "ws_owner").active_mutation_count,
    0,
  );
});

test("process cleanup errors remain structured and do not throw from exit callbacks", async (t) => {
  const { root, processes } = await fixture(t);
  let finished = 0;
  const error = new WriteOwnershipError(
    "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
    "failed cleanup",
  );
  await assert.rejects(
    processes.start({
      workspaceId: "ws_owner",
      cwd: root,
      command: "echo complete",
      yieldTimeMs: 2000,
      mutation: () => ({
        spawned() {},
        finished() {
          finished++;
          throw error;
        },
      }),
    }),
    (value) => {
      assert.deepEqual(toolErrorPayload(value), {
        code: "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
        category: "recovery",
        message: "failed cleanup",
        retryable: false,
      });
      return true;
    },
  );
  assert.equal(finished, 1);
});

test("graceful shutdown surfaces terminal ownership cleanup failure", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "devspace-ownership-shutdown-error-"),
  );
  const root = await realpath(directory);
  const processes = new ProcessSessionManager();
  t.after(async () => {
    await processes.shutdown().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  const error = new WriteOwnershipError(
    "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
    "shutdown cleanup failed",
  );
  const started = await processes.start({
    workspaceId: "ws_owner",
    cwd: root,
    command: `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`,
    yieldTimeMs: 5,
    mutation: () => ({
      spawned() {},
      finished() {
        throw error;
      },
    }),
  });
  assert.equal(started.running, true);
  await assert.rejects(processes.shutdown(), (value) => {
    assert.equal(value, error);
    return true;
  });
});

test("executor persistence failure kills the real process and cleans up only at terminal state", async (t) => {
  const { root, processes } = await fixture(t);
  let finished = false;
  let pid = 0;
  const error = new WriteOwnershipError(
    "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
    "executor persistence failed",
  );
  await assert.rejects(
    processes.start({
      workspaceId: "ws_owner",
      cwd: root,
      command: `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`,
      yieldTimeMs: 2000,
      mutation: () => ({
        spawned(value) {
          pid = value;
          assert.equal(finished, false);
          throw error;
        },
        finished() {
          finished = true;
        },
      }),
    }),
    error,
  );
  assert.ok(pid > 0);
  assert.equal(finished, true);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
