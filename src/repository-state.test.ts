import assert from "node:assert/strict";
import test from "node:test";

import { parsePorcelainV1Z } from "./repository-state.js";

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
