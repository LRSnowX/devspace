import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { git } from "./git.js";
import { parsePorcelainV1Z, readRepositoryState } from "./repository-state.js";

test("parsePorcelainV1Z summarizes bounded repository changes", () => {
  const parsed = parsePorcelainV1Z([
    " M src/modified.ts",
    "D  docs/deleted.md",
    "?? new.txt",
    "UU conflict.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.equal(parsed.total, 5);
  assert.equal(parsed.modified, 1);
  assert.equal(parsed.deleted, 1);
  assert.equal(parsed.renamed, 1);
  assert.equal(parsed.untracked, 1);
  assert.equal(parsed.conflicted, 1);
  assert.deepEqual(parsed.changes.map((change) => change.path), [
    "src/modified.ts",
    "docs/deleted.md",
    "new.txt",
    "conflict.txt",
    "src/new-name.ts",
  ]);
});

test("parsePorcelainV1Z caps the change sample", () => {
  const output = Array.from(
    { length: 25 },
    (_, index) => "?? file-" + index + ".txt",
  ).join("\0") + "\0";
  const parsed = parsePorcelainV1Z(output);

  assert.equal(parsed.total, 25);
  assert.equal(parsed.untracked, 25);
  assert.equal(parsed.changes.length, 20);
});

test("readRepositoryState reports the HEAD commit timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "devspace-repository-state-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.test"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "fixture"]);

  const expectedHead = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const expectedCommittedAt = Number.parseInt(
    (await git(root, ["show", "-s", "--format=%ct", "HEAD"])).stdout.trim(),
    10,
  );
  const state = await readRepositoryState(root);

  assert.equal(state.available, true);
  assert.equal(state.head, expectedHead);
  assert.equal(state.headCommittedAt, expectedCommittedAt);
});
