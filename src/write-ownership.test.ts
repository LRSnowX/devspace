import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WriteOwnership, WriteOwnershipError } from "./write-ownership.js";
import {
  WriteOwnershipStore,
  writeOwnershipPaths,
  type WriteOwnershipRecord,
} from "./write-ownership-store.js";

function fixture(t: TestContext) {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), "devspace-write-ownership-")),
  );
  const root = join(base, "checkout");
  mkdirSync(root);
  const stateDir = join(base, "state");
  const ownership = new WriteOwnership(stateDir);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return {
    base,
    root,
    stateDir,
    ownership,
    paths: writeOwnershipPaths(stateDir, root),
  };
}

function errorCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof WriteOwnershipError);
    assert.equal(error.code, code);
    return true;
  };
}

test("ownership is explicit, canonical-root keyed, persistent, and idempotent", (t) => {
  const { base, root, stateDir, ownership } = fixture(t);
  assert.equal(ownership.inspect(root, "ws_A").state, "unowned");
  assert.equal(ownership.release(root, "ws_A").status, "not_owned");
  assert.throws(
    () => ownership.beginMutation(root, "ws_A", "write"),
    errorCode("WRITE_OWNERSHIP_REQUIRED"),
  );
  assert.equal(ownership.acquire(root, "ws_A").status, "acquired");
  const acquiredAt = ownership.inspect(root, "ws_A").acquiredAt;
  const reopened = new WriteOwnership(stateDir);
  assert.equal(reopened.acquire(root, "ws_A").status, "already_owned");
  assert.equal(reopened.inspect(root, "ws_A").acquiredAt, acquiredAt);
  assert.equal(reopened.inspect(root, "ws_B").state, "owned_by_other");
  assert.throws(
    () => reopened.acquire(root, "ws_B"),
    errorCode("WRITE_OWNERSHIP_CONFLICT"),
  );
  assert.throws(
    () => reopened.release(root, "ws_B"),
    errorCode("WRITE_OWNERSHIP_CONFLICT"),
  );
  assert.throws(
    () => reopened.beginMutation(root, "ws_B", "edit"),
    errorCode("WRITE_OWNERSHIP_CONFLICT"),
  );

  const alias = join(base, "alias");
  symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  // Canonicalization belongs to WorkspaceRegistry, not this state store.
  assert.equal(
    reopened.acquire(realpathSync(alias), "ws_A").status,
    "already_owned",
  );
  for (const name of ["other-project", "worktree-A", "worktree-B"]) {
    const other = join(base, name);
    mkdirSync(other);
    assert.equal(
      reopened.acquire(realpathSync(other), "ws_B").status,
      "acquired",
    );
    assert.equal(reopened.release(other, "ws_B").status, "released");
  }
  assert.equal(reopened.release(root, "ws_A").status, "released");
  assert.equal(ownership.release(root, "ws_A").status, "not_owned");
  assert.equal(ownership.acquire(root, "ws_B").status, "acquired");
});

test("multiple activities have exact identities and cannot release another claim", (t) => {
  const { root, stateDir, ownership, paths } = fixture(t);
  ownership.acquire(root, "ws_A");
  const first = ownership.beginMutation(root, "ws_A", "apply_patch", {
    processIds: [process.pid],
    complete: true,
  });
  const second = ownership.beginMutation(root, "ws_A", "shell_process");
  assert.notEqual(first.activityId, second.activityId);
  assert.equal(ownership.acquire(root, "ws_A").status, "already_owned");
  assert.equal(
    new WriteOwnership(stateDir).inspect(root, "ws_A").activeMutations.length,
    2,
  );
  assert.throws(
    () => ownership.release(root, "ws_A"),
    errorCode("WRITE_OWNERSHIP_BUSY"),
  );
  ownership.recordMutationExecutors(second, {
    processIds: [process.pid],
    complete: false,
  });
  ownership.recordMutationExecutors(second, {
    processIds: [2147483647],
    complete: true,
  });
  assert.deepEqual(
    ownership.inspect(root, "ws_A").activeMutations[1]?.executor_processes,
    [process.pid, 2147483647],
  );
  ownership.endMutation(first);
  ownership.endMutation(first);
  assert.deepEqual(
    ownership
      .inspect(root, "ws_A")
      .activeMutations.map((entry) => entry.activity_id),
    [second.activityId],
  );
  assert.throws(
    () => ownership.release(root, "ws_A"),
    errorCode("WRITE_OWNERSHIP_BUSY"),
  );
  ownership.endMutation(second);
  ownership.release(root, "ws_A");
  ownership.acquire(root, "ws_A");
  const newActivity = ownership.beginMutation(root, "ws_A", "write");
  const before = readFileSync(paths.state, "utf8");
  assert.throws(
    () => ownership.endMutation(first),
    errorCode("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.equal(readFileSync(paths.state, "utf8"), before);
  assert.equal(
    ownership.inspect(root, "ws_A").activeMutations[0]?.activity_id,
    newActivity.activityId,
  );
});

test("invalid inputs and every malformed state fail closed without replacing ownership", (t) => {
  const { root, ownership, paths } = fixture(t);
  ownership.acquire(root, "ws_A");
  const activity = ownership.beginMutation(root, "ws_A", "edit");
  const valid = JSON.parse(
    readFileSync(paths.state, "utf8"),
  ) as WriteOwnershipRecord;
  assert.throws(() => ownership.acquire("relative", "ws_A"), TypeError);
  assert.throws(() => ownership.acquire(root, ""), TypeError);
  assert.throws(
    () =>
      ownership.beginMutation(root, "ws_A", "write", {
        processIds: [],
        complete: true,
      }),
    TypeError,
  );
  const duplicate = {
    ...valid,
    active_mutations: [...valid.active_mutations, ...valid.active_mutations],
  };
  for (const content of [
    "",
    "{",
    "null",
    "{}",
    JSON.stringify({ ...valid, schema_version: 2 }),
    JSON.stringify({ ...valid, canonical_root: `${root}-foreign` }),
    JSON.stringify({ ...valid, ownership_id: "bad" }),
    JSON.stringify({ ...valid, extra: true }),
    JSON.stringify(duplicate),
    JSON.stringify({
      ...valid,
      active_mutations: [
        { ...valid.active_mutations[0], executor_processes: [0] },
      ],
    }),
  ]) {
    writeFileSync(paths.state, content);
    assert.equal(ownership.inspect(root, "ws_A").state, "recovery_required");
    for (const operation of [
      () => ownership.acquire(root, "ws_A"),
      () => ownership.release(root, "ws_A"),
      () => ownership.beginMutation(root, "ws_A", "write"),
      () => ownership.endMutation(activity),
      () => ownership.recover(root),
    ]) {
      assert.throws(operation, errorCode("WRITE_OWNERSHIP_RECOVERY_REQUIRED"));
      assert.equal(readFileSync(paths.state, "utf8"), content);
    }
  }
});

test("publication uses a complete staged file and preserves prior state on failure", (t) => {
  const { root, stateDir, ownership, paths } = fixture(t);
  ownership.acquire(root, "ws_A");
  const original = readFileSync(paths.state, "utf8");
  const originalInode = lstatSync(paths.state).ino;
  let observed = false;
  const interrupted = new WriteOwnership(stateDir, {
    beforePublish: () => {
      observed = true;
      assert.equal(readFileSync(paths.state, "utf8"), original);
      const temporary = readdirSync(paths.directory).find((name) =>
        name.endsWith(".tmp"),
      );
      assert.ok(temporary);
      const prepared = JSON.parse(
        readFileSync(join(paths.directory, temporary), "utf8"),
      ) as WriteOwnershipRecord;
      assert.equal(prepared.active_mutations.length, 1);
      throw new Error("publication failed");
    },
  });
  assert.throws(
    () => interrupted.beginMutation(root, "ws_A", "write"),
    /publication failed/,
  );
  assert.ok(observed);
  assert.equal(readFileSync(paths.state, "utf8"), original);
  assert.equal(lstatSync(paths.state).ino, originalInode);
  assert.deepEqual(readdirSync(paths.directory), [
    paths.state.split(/[\\/]/).at(-1),
  ]);
  ownership.beginMutation(root, "ws_A", "write");
  assert.notEqual(lstatSync(paths.state).ino, originalInode);
});

test("operator recovery is explicit, distinguishes idle and active, and verifies every executor", (t) => {
  const { root, stateDir, ownership, paths } = fixture(t);
  assert.equal(ownership.recover(root).status, "not_owned");
  ownership.acquire(root, "ws_A");
  assert.equal(
    new WriteOwnership(stateDir).inspect(root, "ws_B").state,
    "owned_by_other",
  );
  assert.equal(ownership.recover(root).status, "recovered");
  ownership.acquire(root, "ws_A");
  const unknown = ownership.beginMutation(root, "ws_A", "subagent_turn");
  let before = readFileSync(paths.state, "utf8");
  assert.throws(
    () => ownership.recover(root),
    errorCode("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.equal(readFileSync(paths.state, "utf8"), before);
  ownership.recordMutationExecutors(unknown, {
    processIds: [process.pid],
    complete: true,
  });
  before = readFileSync(paths.state, "utf8");
  assert.throws(
    () => ownership.recover(root),
    errorCode("WRITE_OWNERSHIP_BUSY"),
  );
  assert.equal(readFileSync(paths.state, "utf8"), before);
  const ambiguous = new WriteOwnership(stateDir, {
    processLiveness: () => "unknown",
  });
  assert.throws(
    () => ambiguous.recover(root),
    errorCode("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.equal(readFileSync(paths.state, "utf8"), before);
  const allDead = new WriteOwnership(stateDir, {
    processLiveness: () => "dead",
  });
  assert.deepEqual(allDead.recover(root).recoveredActivityIds, [
    unknown.activityId,
  ]);
  assert.equal(ownership.inspect(root, "ws_B").state, "unowned");
});

test("recovery refuses to remove a state replacement it did not inspect", (t) => {
  const { root, stateDir, ownership, paths } = fixture(t);
  ownership.acquire(root, "ws_A");
  const replacement = {
    ...JSON.parse(readFileSync(paths.state, "utf8")),
    ownership_id: randomUUID(),
    owner_workspace_id: "ws_B",
  };
  const contender = new WriteOwnership(stateDir, {
    beforePublish: () => {
      const replacementPath = `${paths.state}.test-replacement`;
      writeFileSync(replacementPath, JSON.stringify(replacement));
      renameSync(replacementPath, paths.state);
    },
  });
  assert.throws(
    () => contender.recover(root),
    errorCode("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.equal(
    JSON.parse(readFileSync(paths.state, "utf8")).owner_workspace_id,
    "ws_B",
  );
});

test("state permissions are restrictive and symlink state cannot redirect reads or writes", (t) => {
  const { base, root, stateDir, ownership, paths } = fixture(t);
  ownership.acquire(root, "ws_A");
  if (process.platform !== "win32") {
    for (const directory of [stateDir, paths.directory])
      assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert.equal(lstatSync(paths.state).mode & 0o777, 0o600);
    chmodSync(paths.state, 0o666);
    ownership.inspect(root, "ws_A");
    assert.equal(lstatSync(paths.state).mode & 0o777, 0o600);
  }
  const external = join(base, "external");
  writeFileSync(external, "external");
  rmSync(paths.state);
  symlinkSync(external, paths.state);
  assert.throws(
    () => ownership.acquire(root, "ws_A"),
    errorCode("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.equal(readFileSync(external, "utf8"), "external");
  rmSync(paths.state);
  rmSync(paths.directory, { recursive: true });
  const externalDir = join(base, "external-dir");
  mkdirSync(externalDir);
  symlinkSync(
    externalDir,
    paths.directory,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => ownership.acquire(root, "ws_A"),
    errorCode("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.deepEqual(readdirSync(externalDir), []);
});

const childSource = `
import { WriteOwnership } from ${JSON.stringify(new URL("./write-ownership.ts", import.meta.url).href)};
import { existsSync } from 'node:fs';
const { OWNERSHIP_STATE_DIR: stateDir, OWNERSHIP_ROOT: root, OWNERSHIP_WORKSPACE: workspace,
  OWNERSHIP_MODE: mode, OWNERSHIP_BARRIER: barrier } = process.env;
let owner;
process.on('message', (message) => {
  if (message !== 'go') return;
  try {
    owner = new WriteOwnership(stateDir, {
      platform: mode === 'win-crash' ? 'win32' : undefined,
      beforePublish: mode === 'hold' || mode === 'hold-recover' || mode === 'crash' ? () => {
        process.send({ event: 'staged' });
        if (mode === 'crash') process.exit(91);
        const deadline = Date.now() + 10000;
        while (!existsSync(barrier)) {
          if (Date.now() > deadline) throw new Error('Test barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      } : undefined,
      afterReplacementBackup: mode === 'win-crash' ? () => process.exit(92) : undefined,
    });
    let result;
    if (mode === 'active' || mode === 'begin') {
      result = owner.beginMutation(root, workspace, 'shell_process', { processIds: [process.pid], complete: true });
    } else if (mode === 'crash' || mode === 'win-crash') {
      result = owner.beginMutation(root, workspace, 'write');
    } else if (mode === 'recover' || mode === 'hold-recover') {
      result = owner.recover(root);
    } else {
      result = owner.acquire(root, workspace);
    }
    process.send({ event: 'result', result }, () => { if (mode !== 'active') process.exit(0); });
  } catch (error) {
    process.send({ event: 'result', code: error.code, message: error.message }, () => process.exit(0));
  }
});
process.send({ event: 'ready' });
`;

function child(
  t: TestContext,
  stateDir: string,
  root: string,
  workspace: string,
  mode: string,
  barrier = "",
) {
  const processChild = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childSource],
    {
      env: {
        ...process.env,
        OWNERSHIP_STATE_DIR: stateDir,
        OWNERSHIP_ROOT: root,
        OWNERSHIP_WORKSPACE: workspace,
        OWNERSHIP_MODE: mode,
        OWNERSHIP_BARRIER: barrier,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  processChild.stderr!.on("data", (data) => {
    stderr += data.toString();
  });
  const messages: Array<Record<string, any>> = [];
  const waiters = new Set<() => void>();
  processChild.on("message", (message) => {
    messages.push(message as Record<string, any>);
    for (const wake of waiters) wake();
  });
  const exited = new Promise<number | null>((resolveExit) =>
    processChild.once("exit", (code) => {
      resolveExit(code);
      for (const wake of waiters) wake();
    }),
  );
  t.after(async () => {
    if (processChild.exitCode === null && processChild.signalCode === null)
      processChild.kill("SIGKILL");
    await exited;
  });
  const event = (name: string): Promise<Record<string, any>> =>
    new Promise((resolveEvent, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(wake);
        reject(new Error(`Missing child ${name}: ${stderr}`));
      }, 15000);
      const wake = () => {
        const index = messages.findIndex((message) => message.event === name);
        if (index >= 0) {
          clearTimeout(timer);
          waiters.delete(wake);
          resolveEvent(messages.splice(index, 1)[0]!);
        } else if (
          processChild.exitCode !== null ||
          processChild.signalCode !== null
        ) {
          clearTimeout(timer);
          waiters.delete(wake);
          reject(new Error(`Child exited before ${name}: ${stderr}`));
        }
      };
      waiters.add(wake);
      wake();
    });
  return { process: processChild, event, exited };
}

test("separate processes racing to acquire publish exactly one owner", async (t) => {
  const { root, stateDir, ownership, paths } = fixture(t);
  const left = child(t, stateDir, root, "ws_A", "acquire");
  const right = child(t, stateDir, root, "ws_B", "acquire");
  await Promise.all([left.event("ready"), right.event("ready")]);
  left.process.send("go");
  right.process.send("go");
  const results = await Promise.all([
    left.event("result"),
    right.event("result"),
  ]);
  assert.equal(
    results.filter((result) => result.result?.status === "acquired").length,
    1,
  );
  const loser = results.find((result) => result.code);
  assert.ok(loser);
  assert.ok(
    ["WRITE_OWNERSHIP_CONFLICT", "WRITE_OWNERSHIP_BUSY"].includes(loser.code),
  );
  await Promise.all([left.exited, right.exited]);
  const record = JSON.parse(
    readFileSync(paths.state, "utf8"),
  ) as WriteOwnershipRecord;
  assert.equal(
    ownership.acquire(root, record.owner_workspace_id).status,
    "already_owned",
  );
  assert.throws(
    () =>
      ownership.acquire(
        root,
        record.owner_workspace_id === "ws_A" ? "ws_B" : "ws_A",
      ),
    errorCode("WRITE_OWNERSHIP_CONFLICT"),
  );
});

test("a separate process holding the transition mutex blocks a contender without waiting", async (t) => {
  const { base, root, stateDir, ownership, paths } = fixture(t);
  const barrier = join(base, "publish-now");
  const holder = child(t, stateDir, root, "ws_A", "hold", barrier);
  await holder.event("ready");
  holder.process.send("go");
  await holder.event("staged");
  assert.equal(existsSync(paths.state), false);
  assert.equal(
    JSON.parse(readFileSync(paths.mutex, "utf8")).pid,
    holder.process.pid,
  );
  if (process.platform !== "win32")
    assert.equal(lstatSync(paths.mutex).mode & 0o777, 0o600);
  const contender = child(t, stateDir, root, "ws_B", "acquire");
  await contender.event("ready");
  contender.process.send("go");
  assert.equal((await contender.event("result")).code, "WRITE_OWNERSHIP_BUSY");
  assert.equal(existsSync(paths.state), false);
  writeFileSync(barrier, "publish");
  assert.equal((await holder.event("result")).result.status, "acquired");
  await holder.exited;
  assert.equal(ownership.inspect(root, "ws_A").state, "owned_by_workspace");
});

test("process crash before replacement preserves prior JSON and requires explicit mutex recovery", async (t) => {
  const { root, stateDir, ownership, paths } = fixture(t);
  ownership.acquire(root, "ws_A");
  const original = readFileSync(paths.state, "utf8");
  const crashed = child(t, stateDir, root, "ws_A", "crash");
  await crashed.event("ready");
  crashed.process.send("go");
  assert.equal(await crashed.exited, 91);
  assert.equal(readFileSync(paths.state, "utf8"), original);
  const reopened = new WriteOwnership(stateDir);
  assert.throws(
    () => reopened.acquire(root, "ws_A"),
    errorCode("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.equal(reopened.inspect(root, "ws_A").state, "recovery_required");
  assert.equal(reopened.recover(root).status, "recovered");
  assert.equal(reopened.inspect(root, "ws_B").state, "unowned");
  assert.deepEqual(readdirSync(paths.directory), []);
});

test("Windows replacement semantics preserve and recover ownership state", async (t) => {
  const { root, stateDir, ownership, paths } = fixture(t);
  ownership.acquire(root, "ws_A");

  const simulatedWindows = new WriteOwnership(stateDir, { platform: "win32" });
  const activity = simulatedWindows.beginMutation(root, "ws_A", "write");
  assert.equal(
    simulatedWindows.inspect(root, "ws_A").activeMutations[0]?.activity_id,
    activity.activityId,
  );
  simulatedWindows.endMutation(activity);

  const crashed = child(t, stateDir, root, "ws_A", "win-crash");
  await crashed.event("ready");
  crashed.process.send("go");
  assert.equal(await crashed.exited, 92);
  assert.equal(existsSync(paths.state), false);

  const store = new WriteOwnershipStore(stateDir, {
    platform: "win32",
  });
  const restored = store.recover(root, (record) => ({
    result: record,
  }));
  assert.equal(restored?.owner_workspace_id, "ws_A");
  assert.deepEqual(restored?.active_mutations, []);
  assert.equal(
    new WriteOwnership(stateDir).inspect(root, "ws_A").state,
    "owned_by_workspace",
  );
  assert.deepEqual(readdirSync(paths.directory), [
    paths.state.split(/[\\/]/).at(-1),
  ]);
});

test("real executor liveness blocks recovery until the separate process has exited", async (t) => {
  const { root, stateDir, ownership } = fixture(t);
  ownership.acquire(root, "ws_A");
  const executor = child(t, stateDir, root, "ws_A", "active");
  await executor.event("ready");
  executor.process.send("go");
  const activity = (await executor.event("result")).result;
  assert.throws(
    () => ownership.recover(root),
    errorCode("WRITE_OWNERSHIP_BUSY"),
  );
  executor.process.kill("SIGKILL");
  await executor.exited;
  assert.equal(
    new WriteOwnership(stateDir).inspect(root, "ws_A").activeMutations.length,
    1,
  );
  assert.deepEqual(ownership.recover(root).recoveredActivityIds, [
    activity.activityId,
  ]);
});

test("separate owner processes append independent mutations without lost updates", async (t) => {
  const { root, stateDir, ownership } = fixture(t);
  ownership.acquire(root, "ws_A");
  const left = child(t, stateDir, root, "ws_A", "begin");
  const right = child(t, stateDir, root, "ws_A", "begin");
  await Promise.all([left.event("ready"), right.event("ready")]);
  left.process.send("go");
  right.process.send("go");
  const results = await Promise.all([
    left.event("result"),
    right.event("result"),
  ]);
  await Promise.all([left.exited, right.exited]);
  const activities = results
    .filter((result) => result.result)
    .map((result) => result.result);
  if (results.some((result) => result.code)) {
    assert.equal(
      results.find((result) => result.code)?.code,
      "WRITE_OWNERSHIP_BUSY",
    );
    // The test orchestrator explicitly retries the loser after the transition;
    // the ownership core itself never waits or queues.
    const retry = child(t, stateDir, root, "ws_A", "begin");
    await retry.event("ready");
    retry.process.send("go");
    activities.push((await retry.event("result")).result);
    await retry.exited;
  }
  assert.equal(activities.length, 2);
  assert.equal(ownership.inspect(root, "ws_A").activeMutations.length, 2);
  ownership.endMutation(activities[0]);
  assert.deepEqual(
    ownership
      .inspect(root, "ws_A")
      .activeMutations.map((entry) => entry.activity_id),
    [activities[1].activityId],
  );
});

test("operator recovery holds both guards and cannot delete a new contender's claim", async (t) => {
  const { base, root, stateDir, ownership, paths } = fixture(t);
  ownership.acquire(root, "ws_A");
  const original = readFileSync(paths.state, "utf8");
  const barrier = join(base, "recover-now");
  const recovering = child(
    t,
    stateDir,
    root,
    "operator",
    "hold-recover",
    barrier,
  );
  await recovering.event("ready");
  recovering.process.send("go");
  await recovering.event("staged");
  const contender = child(t, stateDir, root, "ws_B", "acquire");
  const otherRecovery = child(t, stateDir, root, "operator", "recover");
  await Promise.all([contender.event("ready"), otherRecovery.event("ready")]);
  contender.process.send("go");
  otherRecovery.process.send("go");
  assert.equal((await contender.event("result")).code, "WRITE_OWNERSHIP_BUSY");
  assert.equal(
    (await otherRecovery.event("result")).code,
    "WRITE_OWNERSHIP_BUSY",
  );
  assert.equal(readFileSync(paths.state, "utf8"), original);
  writeFileSync(barrier, "recover");
  assert.equal((await recovering.event("result")).result.status, "recovered");
  await recovering.exited;
  assert.equal(ownership.acquire(root, "ws_B").status, "acquired");
  assert.equal(ownership.inspect(root, "ws_B").state, "owned_by_workspace");
});

test("undecodable mutexes and interrupted recovery gates fail closed without removal", (t) => {
  const { root, ownership, paths } = fixture(t);
  ownership.acquire(root, "ws_A");
  const original = readFileSync(paths.state, "utf8");
  for (const path of [paths.mutex, paths.recoveryGate]) {
    writeFileSync(path, "{partial");
    assert.equal(ownership.inspect(root, "ws_A").state, "recovery_required");
    assert.throws(
      () => ownership.acquire(root, "ws_A"),
      errorCode("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
    );
    assert.throws(
      () => ownership.recover(root),
      errorCode("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
    );
    assert.equal(readFileSync(path, "utf8"), "{partial");
    assert.equal(readFileSync(paths.state, "utf8"), original);
    rmSync(path);
  }
});

test("ownership and active mutations never expire by age", (t) => {
  const { root, ownership, paths } = fixture(t);
  ownership.acquire(root, "ws_A");
  const activity = ownership.beginMutation(root, "ws_A", "write");
  const record = JSON.parse(
    readFileSync(paths.state, "utf8"),
  ) as WriteOwnershipRecord;
  record.acquired_at = "1970-01-01T00:00:00.000Z";
  record.active_mutations[0]!.started_at = record.acquired_at;
  writeFileSync(paths.state, JSON.stringify(record));
  assert.throws(
    () => ownership.acquire(root, "ws_B"),
    errorCode("WRITE_OWNERSHIP_CONFLICT"),
  );
  assert.throws(
    () => ownership.release(root, "ws_A"),
    errorCode("WRITE_OWNERSHIP_BUSY"),
  );
  assert.throws(
    () => ownership.recover(root),
    errorCode("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.equal(
    ownership.inspect(root, "ws_A").activeMutations[0]?.activity_id,
    activity.activityId,
  );
});
