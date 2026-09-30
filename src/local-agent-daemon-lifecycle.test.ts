import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  LocalAgentDaemonAlreadyRunningError,
  LocalAgentDaemonLock,
  ensureLocalAgentDaemonSocketDir,
  ensureLocalAgentDaemonStateDir,
  isProcessAlive,
  localAgentDaemonPaths,
  removeLocalAgentDaemonFiles,
  ensureLocalAgentDaemonSecret,
} from "./local-agent-daemon-lifecycle.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agentd-lifecycle-test-"));
try {
  const shortDarwinPaths = localAgentDaemonPaths("/tmp/devspace-agentd-short", "darwin");
  assert.equal(shortDarwinPaths.socketPath, "/tmp/devspace-agentd-short/agentd.sock");

  const longStateDir = join("/tmp", "x".repeat(120));
  const longDarwinPaths = localAgentDaemonPaths(longStateDir, "darwin");
  assert.notEqual(longDarwinPaths.socketPath, join(longStateDir, "agentd.sock"));
  assert.equal(Buffer.byteLength(longDarwinPaths.socketPath) <= 103, true);
  assert.equal(
    localAgentDaemonPaths(longStateDir, "darwin").socketPath,
    longDarwinPaths.socketPath,
    "long-path fallback must be deterministic for one state directory",
  );
  if (process.platform !== "win32") {
    const nativeLongPaths = localAgentDaemonPaths(longStateDir);
    ensureLocalAgentDaemonSocketDir(nativeLongPaths);
    assert.equal((await stat(dirname(nativeLongPaths.socketPath))).mode & 0o777, 0o700);
  }

  const paths = localAgentDaemonPaths(join(root, "state"));
  ensureLocalAgentDaemonSocketDir(paths);
  ensureLocalAgentDaemonStateDir(paths.stateDir);
  const lock = new LocalAgentDaemonLock(paths);
  lock.acquire();
  assert.equal(await readFile(paths.lockPath, "utf8"), `${process.pid}\n`);
  assert.throws(
    () => new LocalAgentDaemonLock(paths).acquire(),
    (error: unknown) => error instanceof LocalAgentDaemonAlreadyRunningError,
  );
  await writeFile(paths.pidPath, "999999\n", { mode: 0o600 });
  assert.throws(
    () => new LocalAgentDaemonLock(paths).acquire(),
    (error: unknown) => error instanceof LocalAgentDaemonAlreadyRunningError,
    "a stale diagnostic PID must not override the live lock owner",
  );
  assert.equal(ensureLocalAgentDaemonSecret(paths).length, 64);
  lock.release();

  await writeFile(paths.lockPath, "999999999\n", { mode: 0o600 });
  await writeFile(paths.pidPath, "999999999\n", { mode: 0o600 });
  const recovered = new LocalAgentDaemonLock(paths);
  recovered.acquire();
  assert.equal(await readFile(paths.lockPath, "utf8"), `${process.pid}\n`);
  assert.equal(await readFile(paths.pidPath, "utf8"), `${process.pid}\n`);
  assert.equal(isProcessAlive(process.pid), true);
  recovered.release();

  await writeFile(paths.lockPath, "not-a-pid\n", { mode: 0o600 });
  assert.throws(
    () => new LocalAgentDaemonLock(paths).acquire(),
    (error: unknown) => error instanceof LocalAgentDaemonAlreadyRunningError,
    "an undecodable lock must fail closed instead of being deleted by age",
  );
  assert.equal(await readFile(paths.lockPath, "utf8"), "not-a-pid\n");
  await rm(paths.lockPath, { force: true });

  await writeFile(paths.secretPath, "not-a-hex-secret\n", { mode: 0o600 });
  assert.throws(
    () => ensureLocalAgentDaemonSecret(paths),
    /secret is invalid/,
    "daemon secrets must be exactly 64 hexadecimal characters",
  );
  removeLocalAgentDaemonFiles(paths);
} finally {
  await rm(root, { recursive: true, force: true });
}
