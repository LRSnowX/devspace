import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch } from "./apply-patch.js";
import { fileRevision } from "./file-revision.js";
import { PatchRecoveryManager } from "./patch-recovery.js";
import { isToolOperationError } from "./tool-errors.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const child = fileURLToPath(new URL("./patch-recovery-crash-child.ts", import.meta.url));
function runChild(mode: string, stateDir: string, root: string, milestone = "") {
  return spawnSync(process.execPath, ["--import", "tsx", child, mode, stateDir, root, milestone], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    env: process.env,
  });
}

const patch = `*** Begin Patch
*** Update File: first.txt
@@
-old first
+new first
*** End Patch`;

for (const [milestone, expectedOutcome, expectedFirst] of [
  ["preparing", "preparing_cleaned", "old first\n"],
  ["prepared_file:0", "preparing_cleaned", "old first\n"],
  ["prepared", "restored", "old first\n"],
  ["committing", "restored", "old first\n"],
  ["published:0", "restored", "old first\n"],
  ["all_published", "restored", "old first\n"],
  ["committed", "committed_cleaned", "new first\n"],
] as const) {
  const base = await mkdtemp(join(tmpdir(), "devspace-patch-crash-"));
  const root = join(base, "project");
  const stateDir = join(base, "state");
  await mkdir(root);
  try {
    await writeFile(join(root, "first.txt"), "old first\n");
    await writeFile(join(root, "second.txt"), "old second\n");
    const crashed = runChild("patch", stateDir, root, milestone);
    assert.equal(crashed.status, 91, `${milestone}: ${crashed.stderr}`);
    const recovered = runChild("recover", stateDir, root);
    assert.equal(recovered.status, 0, `${milestone}: ${recovered.stderr}`);
    const outcomes = JSON.parse(recovered.stdout) as Array<{ outcome: string }>;
    assert.equal(outcomes[0]?.outcome, expectedOutcome, milestone);
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), expectedFirst);
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), milestone === "committed" ? "new second\n" : "old second\n");
    const manager = new PatchRecoveryManager(stateDir);
    assert.deepEqual(manager.list(), [], milestone);
    manager.close();
    assert.equal((await readdir(root)).some((name) => name.includes(".devspace-patch-")), false, milestone);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const base = await mkdtemp(join(tmpdir(), "devspace-patch-recovery-recrash-"));
  const root = join(base, "project");
  const stateDir = join(base, "state");
  await mkdir(root);
  try {
    await writeFile(join(root, "first.txt"), "old first\n");
    await writeFile(join(root, "second.txt"), "old second\n");
    assert.equal(runChild("patch", stateDir, root, "all_published").status, 91);

    const recoveryCrashed = runChild("recover-crash", stateDir, root, "restored:0");
    assert.equal(recoveryCrashed.status, 92, recoveryCrashed.stderr);

    const recovered = runChild("recover", stateDir, root);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(
      (JSON.parse(recovered.stdout) as Array<{ outcome: string }>)[0]?.outcome,
      "restored",
    );
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "old first\n");
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "old second\n");
    const manager = new PatchRecoveryManager(stateDir);
    assert.deepEqual(manager.list(), []);
    manager.close();
    assert.equal(
      (await readdir(root)).some((name) => name.includes(".devspace-patch-")),
      false,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

for (const corruption of ["external", "external_symlink", "missing_recovery", "corrupt_recovery"] as const) {
  const base = await mkdtemp(join(tmpdir(), "devspace-patch-degraded-"));
  const root = join(base, "project");
  const other = join(base, "other");
  const stateDir = join(base, "state");
  await mkdir(root);
  await mkdir(other);
  try {
    await writeFile(join(root, "first.txt"), "old first\n");
    await writeFile(join(root, "second.txt"), "old second\n");
    await writeFile(join(other, "first.txt"), "old first\n");
    assert.equal(runChild("patch", stateDir, root, "published:0").status, 91);
    const manager = new PatchRecoveryManager(stateDir);
    const record = manager.list()[0]!;
    if (corruption === "external") await writeFile(join(root, "second.txt"), "external\n");
    if (corruption === "external_symlink") {
      await writeFile(join(base, "outside.txt"), "outside\n");
      await rm(join(root, "second.txt"));
      await symlink(join(base, "outside.txt"), join(root, "second.txt"));
    }
    if (corruption === "missing_recovery" || corruption === "corrupt_recovery") {
      const recovery = record.files[0]!.recoveryPath!;
      if (corruption === "missing_recovery") await rm(join(root, recovery));
      else await writeFile(join(root, recovery), "corrupt\n");
    }
    manager.close();
    const recovered = runChild("recover", stateDir, root);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal((JSON.parse(recovered.stdout) as Array<{ outcome: string }>)[0]?.outcome, "recovery_required");
    const blocked = new PatchRecoveryManager(stateDir);
    assert.equal(blocked.list()[0]?.state, "recovery_required");
    await assert.rejects(applyPatch(root, patch, { journal: blocked }), (error: unknown) => {
      assert.ok(isToolOperationError(error));
      assert.equal(error.payload.code, "PATCH_RECOVERY_REQUIRED");
      assert.equal(error.payload.category, "recovery");
      assert.equal(error.payload.retryable, false);
      return true;
    });
    await applyPatch(other, patch, { journal: blocked });
    assert.equal(await readFile(join(other, "first.txt"), "utf8"), "new first\n");
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "new first\n");
    if (corruption === "external_symlink") assert.equal(await readFile(join(base, "outside.txt"), "utf8"), "outside\n");
    await blocked.acceptCurrent(record.id);
    assert.deepEqual(blocked.list(), []);
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "new first\n");
    blocked.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

for (const milestone of ["published:0", "all_published"] as const) {
  const base = await mkdtemp(join(tmpdir(), "devspace-patch-mixed-"));
  const root = join(base, "project");
  const stateDir = join(base, "state");
  await mkdir(root);
  try {
    await writeFile(join(root, "first.txt"), "old first\n");
    await writeFile(join(root, "second.txt"), "old second\n");
    assert.equal(runChild("patch-mixed", stateDir, root, milestone).status, 91);
    const recovered = runChild("recover", stateDir, root);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal((JSON.parse(recovered.stdout) as Array<{ outcome: string }>)[0]?.outcome, "restored");
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "old second\n");
    await assert.rejects(readFile(join(root, "added.txt")), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const base = await mkdtemp(join(tmpdir(), "devspace-patch-prepared-idempotent-"));
  const root = join(base, "project");
  const stateDir = join(base, "state");
  await mkdir(root);
  try {
    await writeFile(join(root, "first.txt"), "old first\n");
    await writeFile(join(root, "second.txt"), "old second\n");
    assert.equal(runChild("patch", stateDir, root, "prepared").status, 91);
    const manager = new PatchRecoveryManager(stateDir);
    const record = manager.list()[0]!;
    const first = record.files[0]!;
    if (first.finalPath) await rm(join(root, first.finalPath), { force: true });
    if (first.recoveryPath) await rm(join(root, first.recoveryPath), { force: true });
    manager.close();

    const recovered = runChild("recover", stateDir, root);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal((JSON.parse(recovered.stdout) as Array<{ outcome: string }>)[0]?.outcome, "restored");
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "old first\n");
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "old second\n");
    const verified = new PatchRecoveryManager(stateDir);
    assert.deepEqual(verified.list(), []);
    verified.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const base = await mkdtemp(join(tmpdir(), "devspace-patch-recovery-idempotent-"));
  const root = join(base, "project");
  const stateDir = join(base, "state");
  await mkdir(root);
  try {
    await writeFile(join(root, "first.txt"), "old first\n");
    await writeFile(join(root, "second.txt"), "old second\n");
    assert.equal(runChild("patch", stateDir, root, "all_published").status, 91);
    const manager = new PatchRecoveryManager(stateDir);
    const record = manager.list()[0]!;
    const first = record.files[0]!;
    assert.ok(first.recoveryPath);
    await rm(join(root, first.path));
    await rename(join(root, first.recoveryPath), join(root, first.path));
    manager.close();

    const recovered = runChild("recover", stateDir, root);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal((JSON.parse(recovered.stdout) as Array<{ outcome: string }>)[0]?.outcome, "restored");
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "old first\n");
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "old second\n");
    const verified = new PatchRecoveryManager(stateDir);
    assert.deepEqual(verified.list(), []);
    verified.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

for (const phase of ["publication", "rollback"] as const) {
  const base = await mkdtemp(join(tmpdir(), `devspace-patch-windows-gap-${phase}-`));
  const root = join(base, "project");
  const stateDir = join(base, "state");
  await mkdir(root);
  try {
    await writeFile(join(root, "first.txt"), "old first\n");
    await writeFile(join(root, "second.txt"), "old second\n");
    assert.equal(
      runChild("patch", stateDir, root, phase === "publication" ? "committing" : "published:0").status,
      91,
    );
    const manager = new PatchRecoveryManager(stateDir);
    const record = manager.list()[0]!;
    const first = record.files[0]!;
    const backupPath = phase === "publication"
      ? first.replacementBackupPath
      : first.recoveryReplacementBackupPath;
    assert.ok(backupPath);
    await rename(join(root, first.path), join(root, backupPath));
    manager.close();

    const recovered = runChild("recover", stateDir, root);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal((JSON.parse(recovered.stdout) as Array<{ outcome: string }>)[0]?.outcome, "restored");
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "old first\n");
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "old second\n");
    const verified = new PatchRecoveryManager(stateDir);
    assert.deepEqual(verified.list(), []);
    verified.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const base = await mkdtemp(join(tmpdir(), "devspace-patch-committed-cleanup-debt-"));
  const root = join(base, "project");
  const stateDir = join(base, "state");
  await mkdir(root);
  try {
    await writeFile(join(root, "first.txt"), "old first\n");
    await writeFile(join(root, "second.txt"), "old second\n");
    assert.equal(runChild("patch", stateDir, root, "committed").status, 91);

    const manager = new PatchRecoveryManager(stateDir);
    const record = manager.list()[0]!;
    assert.equal(record.state, "committed");
    const recoveryPath = record.files[0]?.recoveryPath;
    assert.ok(recoveryPath);
    await writeFile(join(root, recoveryPath), "corrupt cleanup artifact\n");
    manager.close();

    const recovered = runChild("recover", stateDir, root);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(
      (JSON.parse(recovered.stdout) as Array<{ outcome: string }>)[0]?.outcome,
      "cleanup_failed",
    );

    const operator = new PatchRecoveryManager(stateDir);
    assert.equal(operator.list()[0]?.state, "committed");
    await operator.acceptCurrent(record.id);
    assert.deepEqual(operator.list(), []);
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "new first\n");
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "new second\n");
    assert.equal(await readFile(join(root, recoveryPath), "utf8"), "corrupt cleanup artifact\n");
    operator.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

{
  const base = await mkdtemp(join(tmpdir(), "devspace-patch-journal-validation-"));
  const root = join(base, "project");
  const stateDir = join(base, "state");
  await mkdir(root);
  const manager = new PatchRecoveryManager(stateDir);
  const id = "8b84a29d-a55a-4218-87d6-57aa43084943";
  try {
    await writeFile(join(root, "first.txt"), "original\n");
    manager.createPreparing({
      id,
      root: await realpath(root),
      files: [{
        path: "first.txt",
        original: { kind: "present", revision: fileRevision(Buffer.from("original\n")) },
        published: { kind: "present", revision: fileRevision(Buffer.from("published\n")) },
        finalPath: "../outside.devspace-patch-final",
        recoveryPath: "first.txt.devspace-patch-8b84a29d-a55a-4218-87d6-57aa43084943-0-original",
      }],
    });
    manager.markPrepared(id);
    const outcomes = await manager.reconcileStartup();
    assert.equal(outcomes[0]?.outcome, "recovery_required");
    assert.equal(manager.list()[0]?.state, "recovery_required");
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "original\n");
    await manager.acceptCurrent(id);
    assert.deepEqual(manager.list(), []);
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "original\n");
  } finally {
    manager.close();
    await rm(base, { recursive: true, force: true });
  }
}

{
  const base = await mkdtemp(join(tmpdir(), "devspace-patch-root-blocking-"));
  const root = join(base, "project");
  const stateDir = join(base, "state");
  await mkdir(root);
  const manager = new PatchRecoveryManager(stateDir);
  const id = "f985e1a4-617e-45dd-af15-b19d08099b46";
  try {
    const canonicalRoot = await realpath(root);
    manager.createPreparing({
      id,
      root: canonicalRoot,
      files: [{
        path: "note.txt",
        original: { kind: "absent" },
        published: { kind: "absent" },
      }],
    });
    assert.doesNotThrow(() => manager.assertRootWritable(canonicalRoot));
    manager.markRecoveryRequired(id, "manual inspection required");
    assert.throws(
      () => manager.assertRootWritable(canonicalRoot),
      (error: unknown) => {
        assert.ok(isToolOperationError(error));
        assert.equal(error.payload.code, "PATCH_RECOVERY_REQUIRED");
        return true;
      },
    );
  } finally {
    manager.close();
    await rm(base, { recursive: true, force: true });
  }
}

{
  const base = await mkdtemp(join(tmpdir(), "devspace-patch-success-"));
  const root = join(base, "project");
  await mkdir(root);
  const manager = new PatchRecoveryManager(join(base, "state"));
  try {
    await writeFile(join(root, "first.txt"), "old first\n");
    await applyPatch(root, patch, { journal: manager });
    assert.deepEqual(manager.list(), []);
    assert.equal((await readdir(root)).some((name) => name.includes(".devspace-patch-")), false);
  } finally {
    manager.close();
    await rm(base, { recursive: true, force: true });
  }
}

{
  const base = await mkdtemp(join(tmpdir(), "devspace-patch-cli-"));
  const root = join(base, "project");
  const stateDir = join(base, "state");
  await mkdir(root);
  const manager = new PatchRecoveryManager(stateDir);
  const id = "86c43bb5-8dc0-41b9-9ac4-61ec15d48b6d";
  try {
    await writeFile(join(root, "first.txt"), "current\n");
    manager.createPreparing({ id, root: await realpath(root), files: [{
      path: "first.txt",
      original: { kind: "absent" },
      published: { kind: "absent" },
    }] });
    manager.markRecoveryRequired(id, "operator required");
    const env = { ...process.env, ...writeTestDevspaceConfig(join(base, "config"), {
      storage: { stateDir }, workspaces: { allowedRoots: [base] },
    }) };
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const invoke = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, "recovery", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", env,
    });
    const listed = invoke("list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal((JSON.parse(listed.stdout) as Array<{ id: string }>)[0]?.id, id);
    const shown = invoke("show", id);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal((JSON.parse(shown.stdout) as { state: string }).state, "recovery_required");
    const resolved = invoke("resolve", id, "--accept-current");
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.deepEqual(manager.list(), []);
    assert.equal(await readFile(join(root, "first.txt"), "utf8"), "current\n");
  } finally {
    manager.close();
    await rm(base, { recursive: true, force: true });
  }
}
