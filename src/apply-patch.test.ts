import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, isSamePatchFile, parsePatch, replaceFile } from "./apply-patch.js";
import { fileRevision } from "./file-revision.js";
import { isToolOperationError } from "./tool-errors.js";

const root = await mkdtemp(join(tmpdir(), "devspace-apply-patch-"));
const replacement = join(root, "replacement.txt");
const replacementTemporary = join(root, "replacement.tmp");
await writeFile(replacement, "old\n");
await writeFile(replacementTemporary, "new\n");
await replaceFile(replacementTemporary, replacement, true, "win32");
assert.equal(await readFile(replacement, "utf8"), "new\n");

const sameIdentity = async (): Promise<{ dev: number; ino: number }> => ({ dev: 1, ino: 2 });
const differentIdentity = async (path: string): Promise<{ dev: number; ino: number }> => ({
  dev: 1,
  ino: path.endsWith("foo.txt") ? 3 : 2,
});
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/Foo.txt"), true);
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/foo.txt", sameIdentity), true);
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/bar.txt", sameIdentity), false);
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/foo.txt", differentIdentity), false);

await writeFile(join(root, "alpha.txt"), "one\ntwo\nthree\n");
await writeFile(join(root, "remove.txt"), "remove me\n");
await writeFile(join(root, "windows.txt"), "first\r\nsecond\r\n");

const result = await applyPatch(
  root,
  `*** Begin Patch
*** Add File: nested/added.txt
+new
+file
*** Update File: alpha.txt
@@
 one
-two
+changed
 three
*** Update File: windows.txt
@@
 first
-second
+updated
*** Delete File: remove.txt
*** End Patch`,
);

assert.deepEqual(result.files, [
  { path: "nested/added.txt", operation: "add" },
  { path: "alpha.txt", operation: "update" },
  { path: "windows.txt", operation: "update" },
  { path: "remove.txt", operation: "delete" },
]);
assert.equal(result.additions, 4);
assert.equal(result.removals, 3);
assert.match(result.patch, /diff --git a\/alpha\.txt b\/alpha\.txt/);
assert.match(result.patch, /-two\n\+changed/);
assert.equal(await readFile(join(root, "nested/added.txt"), "utf8"), "new\nfile\n");
assert.equal(await readFile(join(root, "alpha.txt"), "utf8"), "one\nchanged\nthree\n");
assert.equal(await readFile(join(root, "windows.txt"), "utf8"), "first\r\nupdated\r\n");
await assert.rejects(readFile(join(root, "remove.txt"), "utf8"), /ENOENT/);

const revisionRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-revision-"));
await writeFile(join(revisionRoot, "file.txt"), "original\nshared\n");
const originalRevision = fileRevision(Buffer.from("original\nshared\n"));
await writeFile(join(revisionRoot, "file.txt"), "external\nshared\n");
await assert.rejects(
  applyPatch(
    revisionRoot,
    `*** Begin Patch
*** Update File: file.txt
@@
-shared
+patched
*** End Patch`,
    {
      expectedRevisions: [{ path: "file.txt", revision: originalRevision }],
    },
  ),
  (error: unknown) => {
    assert.ok(isToolOperationError(error));
    assert.equal(error.payload.code, "REVISION_CONFLICT");
    assert.equal(error.payload.category, "conflict");
    assert.equal(error.payload.retryable, true);
    assert.equal(error.payload.path, "file.txt");
    assert.equal(error.payload.expected_revision, originalRevision);
    assert.equal(
      error.payload.current_revision,
      fileRevision(Buffer.from("external\nshared\n")),
    );
    return true;
  },
);
assert.equal(
  await readFile(join(revisionRoot, "file.txt"), "utf8"),
  "external\nshared\n",
);

const currentRevision = fileRevision(Buffer.from("external\nshared\n"));
await applyPatch(
  revisionRoot,
  `*** Begin Patch
*** Update File: file.txt
@@
-shared
+patched
*** End Patch`,
  {
    expectedRevisions: [{ path: "file.txt", revision: currentRevision }],
  },
);
assert.equal(
  await readFile(join(revisionRoot, "file.txt"), "utf8"),
  "external\npatched\n",
);

const multiRevisionRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-multi-revision-"));
await writeFile(join(multiRevisionRoot, "first.txt"), "first old\n");
await writeFile(join(multiRevisionRoot, "second.txt"), "second old\n");
const firstRevision = fileRevision(Buffer.from("first old\n"));
const staleSecondRevision = fileRevision(Buffer.from("second older\n"));
await assert.rejects(
  applyPatch(
    multiRevisionRoot,
    `*** Begin Patch
*** Update File: first.txt
@@
-first old
+first new
*** Update File: second.txt
@@
-second old
+second new
*** End Patch`,
    {
      expectedRevisions: [
        { path: "first.txt", revision: firstRevision },
        { path: "second.txt", revision: staleSecondRevision },
      ],
    },
  ),
  /stale file revision for second\.txt/,
);
assert.equal(await readFile(join(multiRevisionRoot, "first.txt"), "utf8"), "first old\n");
assert.equal(await readFile(join(multiRevisionRoot, "second.txt"), "utf8"), "second old\n");

await assert.rejects(
  applyPatch(
    multiRevisionRoot,
    `*** Begin Patch
*** Update File: first.txt
@@
-first old
+first new
*** End Patch`,
    {
      expectedRevisions: [{
        path: "second.txt",
        revision: fileRevision(Buffer.from("second old\n")),
      }],
    },
  ),
  /expected revision path is not touched by patch: second\.txt/,
);
assert.equal(await readFile(join(multiRevisionRoot, "first.txt"), "utf8"), "first old\n");

const absenceRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-absence-"));
await applyPatch(
  absenceRoot,
  `*** Begin Patch
*** Add File: new.txt
+created
*** End Patch`,
  { expectedAbsentPaths: ["new.txt"] },
);
assert.equal(await readFile(join(absenceRoot, "new.txt"), "utf8"), "created\n");

await writeFile(join(absenceRoot, "occupied.txt"), "external\n");
await assert.rejects(
  applyPatch(
    absenceRoot,
    `*** Begin Patch
*** Add File: occupied.txt
+ours
*** End Patch`,
    { expectedAbsentPaths: ["occupied.txt"] },
  ),
  (error: unknown) => {
    assert.ok(isToolOperationError(error));
    assert.equal(error.payload.code, "PATH_STATE_CONFLICT");
    assert.equal(error.payload.category, "conflict");
    assert.equal(error.payload.retryable, true);
    assert.equal(error.payload.path, "occupied.txt");
    assert.equal(error.payload.expected_state, "absent");
    assert.equal(error.payload.current_state, "present");
    return true;
  },
);
assert.equal(await readFile(join(absenceRoot, "occupied.txt"), "utf8"), "external\n");

await writeFile(join(absenceRoot, "source.txt"), "source\n");
await writeFile(join(absenceRoot, "destination.txt"), "destination\n");
await assert.rejects(
  applyPatch(
    absenceRoot,
    `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-source
+moved
*** End Patch`,
    { expectedAbsentPaths: ["destination.txt"] },
  ),
  /path was expected to be absent but exists: destination\.txt/,
);
assert.equal(await readFile(join(absenceRoot, "source.txt"), "utf8"), "source\n");
assert.equal(
  await readFile(join(absenceRoot, "destination.txt"), "utf8"),
  "destination\n",
);

await assert.rejects(
  applyPatch(
    absenceRoot,
    `*** Begin Patch
*** Add File: untouched-precondition-result.txt
+should not publish
*** End Patch`,
    { expectedAbsentPaths: ["other.txt"] },
  ),
  /expected absent path is not touched by patch: other\.txt/,
);
await assert.rejects(
  readFile(join(absenceRoot, "untouched-precondition-result.txt"), "utf8"),
  /ENOENT/,
);

const occupiedRevision = fileRevision(Buffer.from("external\n"));
await assert.rejects(
  applyPatch(
    absenceRoot,
    `*** Begin Patch
*** Add File: occupied.txt
+ours
*** End Patch`,
    {
      expectedRevisions: [{ path: "occupied.txt", revision: occupiedRevision }],
      expectedAbsentPaths: ["occupied.txt"],
    },
  ),
  /path cannot require both a content revision and absence: occupied\.txt/,
);
assert.equal(await readFile(join(absenceRoot, "occupied.txt"), "utf8"), "external\n");

const absentRaceRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-absence-race-"));
await assert.rejects(
  applyPatch(
    absentRaceRoot,
    `*** Begin Patch
*** Add File: raced.txt
+ours
*** End Patch`,
    {
      expectedAbsentPaths: ["raced.txt"],
      beforeCommit: async () => {
        await writeFile(join(absentRaceRoot, "raced.txt"), "external\n");
      },
    },
  ),
  /file changed during patch application: raced\.txt/,
);
assert.equal(await readFile(join(absentRaceRoot, "raced.txt"), "utf8"), "external\n");

await assert.rejects(
  applyPatch(
    multiRevisionRoot,
    `*** Begin Patch
*** Update File: ../outside.txt
@@
-old
+new
*** End Patch`,
  ),
  (error: unknown) => {
    assert.ok(isToolOperationError(error));
    assert.equal(error.payload.code, "PATH_SCOPE_VIOLATION");
    assert.equal(error.payload.category, "scope");
    assert.equal(error.payload.retryable, false);
    assert.equal(error.payload.path, "../outside.txt");
    return true;
  },
);

const rollbackRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-rollback-"));
await writeFile(join(rollbackRoot, "first.txt"), "first old\n");
await writeFile(join(rollbackRoot, "second.txt"), "second old\n");
await assert.rejects(
  applyPatch(
    rollbackRoot,
    `*** Begin Patch
*** Update File: first.txt
@@
-first old
+first new
*** Update File: second.txt
@@
-second old
+second new
*** End Patch`,
    {
      beforePublish: ({ path }) => {
        if (path === "second.txt") throw new Error("injected publish failure");
      },
    },
  ),
  /injected publish failure/,
);
assert.equal(await readFile(join(rollbackRoot, "first.txt"), "utf8"), "first old\n");
assert.equal(await readFile(join(rollbackRoot, "second.txt"), "utf8"), "second old\n");
assert.deepEqual(
  (await readdir(rollbackRoot)).filter((name) => name.includes(".devspace-patch-")),
  [],
);

const deleteRollbackRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-delete-rollback-"));
await writeFile(join(deleteRollbackRoot, "first.txt"), "first\n");
await writeFile(join(deleteRollbackRoot, "second.txt"), "second\n");
await assert.rejects(
  applyPatch(
    deleteRollbackRoot,
    `*** Begin Patch
*** Delete File: first.txt
*** Delete File: second.txt
*** End Patch`,
    {
      beforePublish: ({ path }) => {
        if (path === "second.txt") throw new Error("injected delete failure");
      },
    },
  ),
  /injected delete failure/,
);
assert.equal(await readFile(join(deleteRollbackRoot, "first.txt"), "utf8"), "first\n");
assert.equal(await readFile(join(deleteRollbackRoot, "second.txt"), "utf8"), "second\n");

const moveRollbackRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-move-rollback-"));
await writeFile(join(moveRollbackRoot, "source.txt"), "source old\n");
await writeFile(join(moveRollbackRoot, "destination.txt"), "destination old\n");
await writeFile(join(moveRollbackRoot, "later.txt"), "later old\n");
await assert.rejects(
  applyPatch(
    moveRollbackRoot,
    `*** Begin Patch
*** Add File: nested/new.txt
+new file
*** Update File: source.txt
*** Move to: destination.txt
@@
-source old
+source moved
*** Update File: later.txt
@@
-later old
+later new
*** End Patch`,
    {
      beforePublish: ({ path }) => {
        if (path === "later.txt") throw new Error("injected move rollback failure");
      },
    },
  ),
  /injected move rollback failure/,
);
assert.equal(await readFile(join(moveRollbackRoot, "source.txt"), "utf8"), "source old\n");
assert.equal(
  await readFile(join(moveRollbackRoot, "destination.txt"), "utf8"),
  "destination old\n",
);
assert.equal(await readFile(join(moveRollbackRoot, "later.txt"), "utf8"), "later old\n");
await assert.rejects(readFile(join(moveRollbackRoot, "nested", "new.txt"), "utf8"), /ENOENT/);
await assert.rejects(stat(join(moveRollbackRoot, "nested")), /ENOENT/);

const baselineConflictRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-baseline-conflict-"));
await writeFile(join(baselineConflictRoot, "file.txt"), "original\n");
await assert.rejects(
  applyPatch(
    baselineConflictRoot,
    `*** Begin Patch
*** Update File: file.txt
@@
-original
+patched
*** End Patch`,
    {
      beforeCommit: async () => {
        await writeFile(join(baselineConflictRoot, "file.txt"), "external\n");
      },
    },
  ),
  /file changed during patch application/,
);
assert.equal(await readFile(join(baselineConflictRoot, "file.txt"), "utf8"), "external\n");

const rollbackConflictRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-rollback-conflict-"));
await writeFile(join(rollbackConflictRoot, "first.txt"), "first old\n");
await writeFile(join(rollbackConflictRoot, "second.txt"), "second old\n");
await assert.rejects(
  applyPatch(
    rollbackConflictRoot,
    `*** Begin Patch
*** Update File: first.txt
@@
-first old
+first new
*** Update File: second.txt
@@
-second old
+second new
*** End Patch`,
    {
      beforePublish: async ({ path }) => {
        if (path !== "second.txt") return;
        await writeFile(join(rollbackConflictRoot, "first.txt"), "external after publish\n");
        throw new Error("trigger rollback");
      },
    },
  ),
  (error: unknown) => {
    assert.ok(isToolOperationError(error));
    assert.equal(error.payload.code, "ROLLBACK_FAILED");
    assert.equal(error.payload.category, "recovery");
    assert.equal(error.payload.retryable, false);
    assert.ok(error.payload.recovery_files?.length);
    assert.match(
      error.message,
      /rollback failed: first\.txt: Invalid patch: published file changed before rollback/,
    );
    assert.match(error.message, /recovery files retained:/);
    return true;
  },
);
assert.equal(
  await readFile(join(rollbackConflictRoot, "first.txt"), "utf8"),
  "external after publish\n",
);
assert.equal(await readFile(join(rollbackConflictRoot, "second.txt"), "utf8"), "second old\n");

const concurrentRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-concurrent-"));
await writeFile(join(concurrentRoot, "file.txt"), "zero\n");
let releaseFirst!: () => void;
const firstMayFinish = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
let firstEnteredCommit = false;
let secondEnteredCommit = false;
const firstApply = applyPatch(
  concurrentRoot,
  `*** Begin Patch
*** Update File: file.txt
@@
-zero
+one
*** End Patch`,
  {
    beforeCommit: async () => {
      firstEnteredCommit = true;
      await firstMayFinish;
    },
  },
);
while (!firstEnteredCommit) await new Promise((resolve) => setTimeout(resolve, 1));
const secondApply = applyPatch(
  concurrentRoot,
  `*** Begin Patch
*** Update File: file.txt
@@
-one
+two
*** End Patch`,
  {
    beforeCommit: () => {
      secondEnteredCommit = true;
    },
  },
);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(secondEnteredCommit, false);
releaseFirst();
await firstApply;
await secondApply;
assert.equal(secondEnteredCommit, true);
assert.equal(await readFile(join(concurrentRoot, "file.txt"), "utf8"), "two\n");

const stagedViewRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-staged-view-"));
await writeFile(join(stagedViewRoot, "source.txt"), "one\n");
const stagedViewResult = await applyPatch(
  stagedViewRoot,
  `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-one
+two
*** Update File: destination.txt
@@
-two
+three
*** End Patch`,
);
assert.deepEqual(stagedViewResult.files, [
  { path: "destination.txt", previousPath: "source.txt", operation: "move" },
  { path: "destination.txt", operation: "update" },
]);
assert.equal(await readFile(join(stagedViewRoot, "destination.txt"), "utf8"), "three\n");
await assert.rejects(readFile(join(stagedViewRoot, "source.txt"), "utf8"), /ENOENT/);

if (process.platform !== "win32") await chmod(join(root, "alpha.txt"), 0o755);
const moveResult = await applyPatch(
  root,
  `*** Begin Patch
*** Update File: alpha.txt
*** Move to: moved/alpha.txt
@@
-one
+ONE
 changed
*** End Patch`,
);
assert.deepEqual(moveResult.files, [
  { path: "moved/alpha.txt", previousPath: "alpha.txt", operation: "move" },
]);
assert.equal(await readFile(join(root, "moved/alpha.txt"), "utf8"), "ONE\nchanged\nthree\n");
if (process.platform !== "win32") {
  assert.notEqual((await stat(join(root, "moved/alpha.txt"))).mode & 0o111, 0);
}
await assert.rejects(readFile(join(root, "alpha.txt"), "utf8"), /ENOENT/);

await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Add File: ../escape.txt
+no
*** End Patch`,
  ),
  /path escapes the workspace/,
);

const outside = await mkdtemp(join(tmpdir(), "devspace-apply-patch-outside-"));
await symlink(outside, join(root, "outside-link"), process.platform === "win32" ? "junction" : "dir");
await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Add File: outside-link/escape.txt
+no
*** End Patch`,
  ),
  /path resolves outside the workspace/,
);

await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Update File: moved/alpha.txt
@@
-not present
+replacement
*** End Patch`,
  ),
  /could not find hunk context/,
);
assert.equal(await readFile(join(root, "moved/alpha.txt"), "utf8"), "ONE\nchanged\nthree\n");

await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Add File: should-not-exist.txt
+staged
*** Update File: moved/alpha.txt
@@
-missing context
+replacement
*** End Patch`,
  ),
  /could not find hunk context/,
);
await assert.rejects(readFile(join(root, "should-not-exist.txt"), "utf8"), /ENOENT/);
assert.equal(await readFile(join(root, "moved/alpha.txt"), "utf8"), "ONE\nchanged\nthree\n");

const splitHunkRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-split-hunk-"));
await writeFile(
  join(splitHunkRoot, "long.txt"),
  Array.from({ length: 20 }, (_, index) => String(index + 1)).join("\n") + "\n",
);
const splitHunkResult = await applyPatch(
  splitHunkRoot,
  `*** Begin Patch
*** Update File: long.txt
@@
 1
-2
+two
 3
@@
 17
-18
+eighteen
 19
*** End Patch`,
);
assert.equal(splitHunkResult.patch.match(/^@@ /gm)?.length, 2);
assert.equal(
  await readFile(join(splitHunkRoot, "long.txt"), "utf8"),
  [
    "1", "two", "3", "4", "5", "6", "7", "8", "9", "10",
    "11", "12", "13", "14", "15", "16", "17", "eighteen", "19", "20",
  ].join("\n") + "\n",
);

const trailingSpaceRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-trailing-space-"));
await writeFile(join(trailingSpaceRoot, "spaces.txt"), "old\n");
const trailingSpaceResult = await applyPatch(
  trailingSpaceRoot,
  `*** Begin Patch
*** Update File: spaces.txt
@@
-old
+new${"   "}
*** End Patch`,
);
assert.equal(trailingSpaceResult.patch.endsWith("+new   "), true);
assert.equal(await readFile(join(trailingSpaceRoot, "spaces.txt"), "utf8"), "new   \n");

assert.throws(() => parsePatch("*** Begin Patch\n*** End Patch"), /contains no file actions/);
assert.throws(() => parsePatch("*** Add File: bad.txt\n+x"), /missing .* marker/);
assert.throws(
  () => parsePatch("*** Begin Patch\n*** Add File: empty.txt\n*** End Patch"),
  /has no content/,
);

const overwriteRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-overwrite-"));
await writeFile(join(overwriteRoot, "duplicate.txt"), "old content\n");
const overwriteResult = await applyPatch(
  overwriteRoot,
  `*** Begin Patch
*** Add File: duplicate.txt
+new content
*** End Patch`,
);
assert.deepEqual(overwriteResult.files, [
  { path: "duplicate.txt", operation: "update" },
]);
assert.equal(await readFile(join(overwriteRoot, "duplicate.txt"), "utf8"), "new content\n");

await writeFile(join(overwriteRoot, "source.txt"), "from\n");
await writeFile(join(overwriteRoot, "destination.txt"), "existing\n");
await applyPatch(
  overwriteRoot,
  `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-from
+new
*** End Patch`,
);
assert.equal(await readFile(join(overwriteRoot, "destination.txt"), "utf8"), "new\n");
await assert.rejects(readFile(join(overwriteRoot, "source.txt"), "utf8"), /ENOENT/);

const noNewlineRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-newline-"));
await writeFile(join(noNewlineRoot, "no-newline.txt"), "old");
await applyPatch(
  noNewlineRoot,
  `*** Begin Patch
*** Update File: no-newline.txt
@@
-old
+new
*** End Patch`,
);
assert.equal(await readFile(join(noNewlineRoot, "no-newline.txt"), "utf8"), "new\n");

const eofRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-eof-"));
await writeFile(join(eofRoot, "tail.txt"), "first\nsecond\n");
await applyPatch(
  eofRoot,
  `*** Begin Patch
*** Update File: tail.txt
@@
 first
-second
+second updated
*** End of File
*** End Patch`,
);
assert.equal(await readFile(join(eofRoot, "tail.txt"), "utf8"), "first\nsecond updated\n");
await assert.rejects(
  applyPatch(
    eofRoot,
    `*** Begin Patch
*** Update File: tail.txt
@@
 first
+not tail
*** End of File
*** End Patch`,
  ),
  /could not find hunk context/,
);

const lenientRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-lenient-"));
await writeFile(join(lenientRoot, "file.txt"), "one\n");
await applyPatch(
  lenientRoot,
  `<<'EOF'
 *** Begin Patch
  *** Update File: file.txt
@@
-one
+two
 *** End Patch
EOF`,
);
assert.equal(await readFile(join(lenientRoot, "file.txt"), "utf8"), "two\n");

await applyPatch(
  lenientRoot,
  `*** Begin Patch
*** Environment ID: ignored
*** Update File: file.txt
 two
+three
*** End Patch`,
);
assert.equal(await readFile(join(lenientRoot, "file.txt"), "utf8"), "two\nthree\n");

await assert.rejects(
  applyPatch(
    lenientRoot,
    `*** Begin Patch
*** Add File: ${join(lenientRoot, "absolute.txt")}
+no
*** End Patch`,
  ),
  /path must be relative/,
);

await writeFile(join(lenientRoot, "binary.dat"), Buffer.from([0, 159, 146, 150]));
await assert.rejects(
  applyPatch(
    lenientRoot,
    `*** Begin Patch
*** Update File: binary.dat
@@
-x
+y
*** End Patch`,
  ),
  /not valid UTF-8|binary/,
);
