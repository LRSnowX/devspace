import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import test, { type TestContext } from "node:test";
import {
  startOwnershipChild,
  childMessage,
} from "./test-support/ownership-process-fixture.js";
import { WriteOwnership, WriteOwnershipError } from "./write-ownership.js";
import { writeOwnershipPaths } from "./write-ownership-store.js";

export function ownershipFixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ds-ownership-b2-")));
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
const code = (expected: string) => (error: unknown) =>
  error instanceof WriteOwnershipError && error.code === expected;

test("retention and acquire exclude each other; the mutex is not held across lifecycle work", (t) => {
  const { root, ownership, paths } = ownershipFixture(t);
  ownership.acquire(root, "ws_A");
  assert.throws(
    () => ownership.beginDestructiveRetention(root, "managed_worktree"),
    code("WRITE_OWNERSHIP_BUSY"),
  );
  ownership.release(root, "ws_A");
  const guard = ownership.beginDestructiveRetention(root, "managed_worktree");
  assert.equal(existsSync(paths.mutex), false);
  assert.equal(ownership.inspect(root, "ws_A").state, "unowned");
  assert.throws(
    () => ownership.acquire(root, "ws_A"),
    code("WRITE_OWNERSHIP_BUSY"),
  );
  assert.throws(
    () => ownership.beginMutation(root, "ws_A", "write"),
    code("WRITE_OWNERSHIP_BUSY"),
  );
  ownership.endDestructiveRetention(guard);
  const replacement = ownership.beginDestructiveRetention(
    root,
    "managed_worktree",
  );
  assert.throws(
    () => ownership.endDestructiveRetention(guard),
    code("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.equal(
    ownership.diagnostics(root).retention?.guard_id,
    replacement.guardId,
  );
  ownership.endDestructiveRetention(replacement);
  ownership.endDestructiveRetention(replacement);
  assert.equal(ownership.acquire(root, "ws_A").status, "acquired");
});

test("genuine separate-process acquire versus retention-start race has exactly one winner", async (t) => {
  const { base, root } = ownershipFixture(t);
  for (let iteration = 0; iteration < 6; iteration++) {
    const stateDir = join(base, `race-${iteration}`);
    const owner = await startOwnershipChild(t, "acquire", stateDir, root);
    const retention = await startOwnershipChild(t, "retention", stateDir, root);
    const first = childMessage(owner);
    const second = childMessage(retention);
    owner.send("go");
    retention.send("go");
    const outcomes = await Promise.all([first, second]);
    assert.equal(outcomes.filter((result) => result.ok).length, 1);
    const persisted = new WriteOwnership(stateDir).diagnostics(root);
    assert.equal(
      Number(!!persisted.ownership) + Number(!!persisted.retention),
      1,
    );
    assert.equal(existsSync(writeOwnershipPaths(stateDir, root).mutex), false);
    owner.kill("SIGKILL");
    retention.kill("SIGKILL");
    await Promise.all([once(owner, "exit"), once(retention, "exit")]);
  }
});

test("retention crash survives restart; dead parent and ambiguous/partial lifecycle cannot authorize recovery", async (t) => {
  const { root, stateDir, paths } = ownershipFixture(t);
  const child = await startOwnershipChild(t, "retention", stateDir, root);
  const result = childMessage(child);
  child.send("go");
  assert.equal((await result).ok, true);
  child.kill("SIGKILL");
  await once(child, "exit");
  const restarted = new WriteOwnership(stateDir);
  assert.equal(existsSync(paths.retention), true);
  assert.equal(restarted.inspect(root, "ws_A").state, "recovery_required");
  assert.throws(
    () => restarted.acquire(root, "ws_A"),
    code("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.throws(
    () => restarted.recover(root, () => true),
    code("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
});

test("explicit guard recovery checks live/unknown/dead executors AND filesystem safety", (t) => {
  const { root, stateDir, ownership, paths } = ownershipFixture(t);
  ownership.beginDestructiveRetention(root, "managed_worktree", {
    processIds: [process.pid],
    complete: true,
  });
  assert.throws(
    () => ownership.recover(root, () => true),
    code("WRITE_OWNERSHIP_BUSY"),
  );
  const unknown = new WriteOwnership(stateDir, {
    processLiveness: () => "unknown",
  });
  assert.throws(
    () => unknown.recover(root, () => true),
    code("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  const dead = new WriteOwnership(stateDir, { processLiveness: () => "dead" });
  assert.throws(
    () => dead.recover(root, () => false),
    code("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.equal(existsSync(paths.retention), true);
  assert.equal(dead.recover(root, () => true).status, "recovered");
  assert.equal(existsSync(paths.retention), false);
});

test("guard publication is atomic; corrupt/unknown/mismatched guards fail closed and remain diagnosable", (t) => {
  const { root, stateDir, ownership, paths } = ownershipFixture(t);
  const observed = new WriteOwnership(stateDir, {
    beforePublish: () => {
      assert.equal(existsSync(paths.retention), false);
      assert.throws(
        () => new WriteOwnership(stateDir).acquire(root, "ws_racer"),
        code("WRITE_OWNERSHIP_BUSY"),
      );
    },
  });
  const guard = observed.beginDestructiveRetention(root, "managed_worktree");
  const original = readFileSync(paths.retention, "utf8");
  for (const content of [
    "{",
    JSON.stringify({ ...JSON.parse(original), schema_version: 99 }),
    JSON.stringify({
      ...JSON.parse(original),
      canonical_root: join(root, "other"),
    }),
  ]) {
    writeFileSync(paths.retention, content);
    assert.throws(
      () => ownership.acquire(root, "ws_A"),
      code("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
    );
    assert.throws(
      () => ownership.recover(root, () => true),
      code("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
    );
    assert.equal(readFileSync(paths.retention, "utf8"), content);
    assert.ok(
      ownership.list().errors.length ||
        ownership.list().roots.some((entry) => entry.errors.length),
    );
  }
  writeFileSync(paths.retention, original);
  ownership.endDestructiveRetention(guard);
});

test("recovery cannot remove an externally replaced guard, even after the old guard was inspected", (t) => {
  const { root, stateDir, ownership, paths } = ownershipFixture(t);
  ownership.beginDestructiveRetention(root, "managed_worktree", {
    processIds: [process.pid],
    complete: true,
  });
  const dead = new WriteOwnership(stateDir, { processLiveness: () => "dead" });
  const replacement = {
    ...JSON.parse(readFileSync(paths.retention, "utf8")),
    guard_id: randomUUID(),
  };
  assert.throws(
    () =>
      dead.recover(root, () => {
        writeFileSync(paths.retention, JSON.stringify(replacement));
        return true;
      }),
    code("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.equal(
    JSON.parse(readFileSync(paths.retention, "utf8")).guard_id,
    replacement.guard_id,
  );
});

test("unexpected coexisting ownership/retention is fail-closed, not normalized automatically", (t) => {
  const { root, ownership, paths } = ownershipFixture(t);
  const guard = ownership.beginDestructiveRetention(root, "managed_worktree");
  const claim = JSON.stringify({
    schema_version: 1,
    canonical_root: root,
    ownership_id: randomUUID(),
    owner_workspace_id: "ws_intruder",
    acquired_at: new Date().toISOString(),
    active_mutations: [],
  });
  writeFileSync(paths.state, claim);
  assert.equal(
    ownership.inspect(root, "ws_intruder").state,
    "recovery_required",
  );
  assert.throws(
    () => ownership.acquire(root, "ws_intruder"),
    code("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.throws(
    () => ownership.endDestructiveRetention(guard),
    code("WRITE_OWNERSHIP_RECOVERY_REQUIRED"),
  );
  assert.equal(readFileSync(paths.state, "utf8"), claim);
  assert.equal(existsSync(paths.retention), true);
});
