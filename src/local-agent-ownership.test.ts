import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Result } from "better-result";
import { LocalAgentClient } from "./local-agent-client.js";
import { WriteOwnership, WriteOwnershipError } from "./write-ownership.js";
import {
  AgentOwnershipError,
  toAgentErrorPayload,
} from "./local-agent-errors.js";
import { toolErrorPayload, toolErrorPayloadSchema } from "./tool-errors.js";
import {
  startOwnershipChild,
  childMessage,
} from "./test-support/ownership-process-fixture.js";

function unwrap<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

test("real daemon shares Host ownership across processes, modes, lifetime, terminal failure, crash and restart", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ds-agent-owner-")));
  const root = join(base, "project");
  mkdirSync(root);
  const stateDir = join(base, "state");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ownership = new WriteOwnership(stateDir);
  let daemon = await startOwnershipChild(t, "daemon", stateDir, root);
  const client = new LocalAgentClient({
    stateDir,
    configRevision: "ownership-fixture",
    requestTimeoutMs: 3_000,
    spawnDaemon: () => {
      throw new Error("Tests must never invoke a real provider daemon");
    },
  });
  const scope = { workspaceId: "ws_A", workspaceRoot: root };
  const start = (
    prompt: string,
    writeMode?: "read_only" | "allowed" | "full_access",
    workspaceId = "ws_A",
  ) =>
    client.start({
      target: "codex",
      prompt,
      workspaceRoot: root,
      workspaceId,
      writeMode,
    });
  const readonly = unwrap(await start("done", "read_only"));
  assert.equal(
    unwrap(await client.wait([readonly.id], scope, 2_000))[0]?.status,
    "completed",
  );
  for (const mode of [undefined, "allowed", "full_access"] as const) {
    const result = await start("done", mode);
    assert.ok(result.isErr());
    assert.ok(AgentOwnershipError.is(result.error));
    assert.equal(result.error.code, "WRITE_OWNERSHIP_REQUIRED");
  }
  const defaultContinuation = await client.continue(
    readonly.id,
    "done",
    {},
    scope,
  );
  assert.ok(defaultContinuation.isErr());
  assert.equal(defaultContinuation.error.code, "WRITE_OWNERSHIP_REQUIRED");
  const direct = await client.start({
    target: "codex",
    prompt: "done",
    workspaceRoot: root,
  });
  assert.ok(direct.isErr());
  assert.equal(direct.error.code, "WORKSPACE_SCOPE_REQUIRED");
  ownership.acquire(root, "ws_A");
  const conflict = await start("done", "full_access", "ws_B");
  assert.ok(conflict.isErr());
  assert.equal(conflict.error.code, "WRITE_OWNERSHIP_CONFLICT");
  assert.equal(toAgentErrorPayload(conflict.error).owner_workspace_id, "ws_A");
  assert.equal(
    toolErrorPayloadSchema.parse(toolErrorPayload(conflict.error)).category,
    "conflict",
  );
  const firstEntered = childMessage(daemon);
  const first = unwrap(await start("hold"));
  await firstEntered;
  const secondEntered = childMessage(daemon);
  const second = unwrap(await start("hold", "full_access"));
  await secondEntered;
  const before = ownership
    .inspect(root, "ws_A")
    .activeMutations.map((entry) => entry.activity_id);
  assert.equal(before.length, 2);
  assert.throws(
    () => ownership.release(root, "ws_A"),
    (error) =>
      error instanceof WriteOwnershipError &&
      error.code === "WRITE_OWNERSHIP_BUSY",
  );
  unwrap(await client.get(first.id, scope));
  unwrap(await client.wait([first.id, second.id], scope, 0));
  assert.deepEqual(
    ownership
      .inspect(root, "ws_A")
      .activeMutations.map((entry) => entry.activity_id),
    before,
  );
  for (const prompt of ["done", "fail", "cancel"]) {
    const agent = unwrap(await start(prompt));
    await client.wait([agent.id], scope, 2_000);
    assert.equal(ownership.inspect(root, "ws_A").activeMutations.length, 2);
  }
  const otherRead = unwrap(await start("done", "read_only", "ws_B"));
  unwrap(
    await client.wait(
      [otherRead.id],
      { workspaceId: "ws_B", workspaceRoot: root },
      2_000,
    ),
  );
  assert.equal(ownership.inspect(root, "ws_A").activeMutations.length, 2);
  const released = childMessage(daemon);
  daemon.send("release");
  await released;
  unwrap(await client.wait([first.id, second.id], scope, 2_000));
  assert.equal(ownership.inspect(root, "ws_A").activeMutations.length, 0);
  const continuedEntered = childMessage(daemon);
  const continued = unwrap(await client.continue(first.id, "hold", {}, scope));
  await continuedEntered;
  assert.equal(continued.id, first.id);
  assert.equal(ownership.inspect(root, "ws_A").activeMutations.length, 1);
  const ambiguous = unwrap(await start("ambiguous"));
  unwrap(await client.wait([ambiguous.id], scope, 2_000));
  assert.equal(ownership.inspect(root, "ws_A").activeMutations.length, 2);
  assert.throws(
    () => ownership.recover(root),
    (error) =>
      error instanceof WriteOwnershipError &&
      error.code === "WRITE_OWNERSHIP_BUSY",
  );
  daemon.kill("SIGKILL");
  await once(daemon, "exit");
  const persisted = new WriteOwnership(stateDir).inspect(root, "ws_A");
  assert.equal(persisted.activeMutations.length, 2);
  daemon = await startOwnershipChild(t, "daemon", stateDir, root);
  assert.equal(ownership.inspect(root, "ws_A").activeMutations.length, 2);
  assert.equal(unwrap(await client.get(first.id, scope)).status, "error");
  // Fixture executor evidence is exhaustive: its turn runs entirely in the
  // killed fixture process, without shell/provider children.
  assert.equal(ownership.recover(root).recoveredActivityIds.length, 2);
  ownership.acquire(root, "ws_B");
  assert.equal(ownership.inspect(root, "ws_B").state, "owned_by_workspace");
  daemon.send("stop");
  await once(daemon, "exit");
});
