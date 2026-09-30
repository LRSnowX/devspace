# Patch crash recovery design

This document defines the preflight architecture for recovering interrupted
`apply_patch` transactions after a DevSpace process crash or service restart.

It deliberately does **not** claim power-loss durability. Filesystem and SQLite
fsync ordering across platforms are a separate, stronger contract.

## Goal

If DevSpace terminates while publishing a multi-file `apply_patch`, the next
server start should:

1. discover the incomplete transaction without scanning arbitrary project
   directories for orphan temporary files;
2. automatically restore the pre-patch state when every affected path can be
   classified safely;
3. refuse to overwrite external changes when state is ambiguous;
4. keep read/diagnostic workflows available even when automatic recovery is not
   safe;
5. block further patch publication for an affected workspace root until the
   recovery state is resolved.

## Contract boundary

### In scope

- abrupt DevSpace process termination;
- normal service restart after such termination;
- incomplete patch publication and rollback cleanup;
- persistent discovery of transaction recovery files;
- safe startup reconciliation;
- structured `apply_patch` blocking for roots that require manual recovery;
- local CLI inspection and explicit resolution of unresolved recovery state.

### Out of scope

- power loss, kernel panic, storage-controller failure, or guaranteed physical
  persistence ordering;
- database-style atomic visibility across multiple files;
- distributed locking across multiple independent DevSpace server processes;
- automatic overwriting of a path that no longer matches either the original or
  published state recorded by the transaction;
- a new model-facing recovery tool.

## Persistence model

Crash recovery uses two persistent layers with different responsibilities.

### SQLite journal

DevSpace stores transaction metadata in the existing state database under
`storage.stateDir`.

The journal identifies:

- transaction id;
- canonical workspace root;
- lifecycle state;
- creation/update timestamps;
- every touched workspace-relative path;
- original state for each path;
- intended published state for each path;
- same-directory prepared final path, when applicable;
- same-directory recovery-file path, when the original existed.

The journal is written **before the first destructive filesystem mutation**.

### Same-directory recovery files

Original bytes remain in same-directory recovery files beside each destination.
Final prepared files also remain beside their destinations until published.

Keeping these files on the target filesystem preserves the existing same-device
rename assumptions. SQLite stores their identities; startup recovery never
guesses ownership from a filename pattern alone.

## File-state identity

Each path state is one of:

- `absent`; or
- `present` with:
  - SHA-256 content revision;
  - file mode where supported by the current patch engine.

The transaction records both:

- `original`: state observed on first touch;
- `published`: state the patch intends to leave after commit.

Recovery classifies the current filesystem state against both values.

## Journal lifecycle

Recommended lifecycle:

### `preparing`

The transaction id, complete target-path manifest, and all planned
transaction-owned temporary/recovery filenames have been persisted, but no
destructive project-file mutation is allowed yet.

Temporary/recovery files may be only partially created in this state. Startup
recovery may safely remove any listed transaction-owned temporary files and
delete the journal row because publication has not started.

Persisting `preparing` before creating temporary files avoids a crash window
where orphan `.devspace-patch-*` files exist without an owner record.

### `prepared`

All final temporary files and original recovery files exist. The complete
journal payload has been persisted. No destructive mutation has started.

### `committing`

DevSpace has persisted intent to begin publication. One or more path mutations
may have happened.

The journal does not require a durable progress write after every file mutation.
Startup recovery can infer progress by comparing each current path against its
recorded original and published states. This avoids a new crash window between
filesystem mutation and per-file progress persistence.

### `committed`

Every intended path mutation completed successfully.

This state must be persisted **before** deleting recovery files. If DevSpace
crashes after the commit marker but before cleanup, startup may safely preserve
the published files and clean only transaction-owned temporary/recovery files.

### `recovery_required`

Automatic rollback was not safe because at least one affected path matched
neither its recorded original nor published state, or a required recovery file
was missing/corrupt.

The journal and remaining recovery files are retained.

## Publication ordering

For one patch:

1. parse and stage the complete logical patch;
2. validate expected revisions and absence preconditions;
3. generate the transaction id and all same-directory transaction-owned
   filenames;
4. persist the complete journal as `preparing`;
5. create same-directory final temporary files;
6. create same-directory original recovery files;
7. revalidate first-touch baselines;
8. persist `prepared`;
9. persist `committing`;
10. publish paths using the existing transactional publication logic;
11. persist `committed`;
12. remove remaining transaction-owned temporary/recovery files;
13. delete the journal row.

The existing in-process rollback path remains active for ordinary catchable
failures. The persistent journal is protection for termination between steps.

## Startup reconciliation

Recovery runs before the HTTP server begins listening.

The normal `devspace serve` path already has a pre-listen startup-cleanup
phase. Patch recovery should run there, before managed-worktree cleanup and
before `createServer(...)` exposes MCP tools.

For each journal:

### Journal state `preparing`

- no project path may have been destructively mutated;
- remove only listed transaction-owned temporary/recovery files that exist;
- delete the journal row;
- never modify project target paths.

### Journal state `committed`

- do not change published workspace files;
- remove only transaction-owned final/recovery temporary files that still
  exist;
- delete the journal row after cleanup succeeds;
- if cleanup cannot be completed, log the condition but do not roll back a
  committed transaction.

### Journal state `prepared` or `committing`

First classify **all** touched paths without changing any of them:

- current == original → already safe;
- current == published → eligible for rollback;
- current matches neither → ambiguous/external state.

Only if every path is classifiable may automatic rollback begin.

Then:

1. restore every path currently matching the published state back to original;
2. verify the complete workspace path set now matches the recorded originals;
3. remove transaction-owned temporary/recovery files;
4. delete the journal row.

### Ambiguous state

If any path matches neither original nor published:

- perform no automatic rollback for that transaction;
- mark the journal `recovery_required`;
- retain all remaining recovery files;
- log the transaction id, workspace root, and ambiguous paths;
- continue server startup in degraded mode.

This all-classify-before-write rule prevents partial automatic recovery from
making an already ambiguous transaction harder to inspect.

## Degraded-mode behavior

An unresolved `recovery_required` transaction does **not** prevent the whole
DevSpace service from starting.

Read-oriented and diagnostic capabilities remain available so the user can
inspect the workspace.

Codex `apply_patch` for the affected canonical workspace root is blocked before
the patch engine runs and returns:

```text
status: "error"
error: {
  code: "PATCH_RECOVERY_REQUIRED",
  category: "recovery",
  retryable: false,
  ...
}
```

Other unrelated workspace roots remain usable.

## Local CLI recovery workflow

No model-facing recovery tool is added.

The local CLI should provide a small administrative surface, for example:

```text
devspace recovery list
devspace recovery show <transaction-id>
devspace recovery resolve <transaction-id> --accept-current
```

`list` and `show` are read-only.

`--accept-current` is an explicit operator action after manual inspection. It:

- records that the operator accepts the current filesystem state;
- removes only transaction-owned temporary/recovery files that still exist;
- deletes the journal entry.

It is also allowed for a lingering `committed` journal whose project state is
already final but startup could not safely clean one or more recovery
artifacts. In that case it still never rewrites project target files; corrupt
or unrecognized artifacts may be left in place rather than deleted blindly.

It must **not** rewrite project files.

An automatic `--restore-original` command should not be added in the first
version. Restoring ambiguous state is exactly the case where DevSpace lacks
enough information to overwrite safely.

## Store design

Use a dedicated patch-transaction store backed by the existing DevSpace SQLite
database rather than coupling recovery records to workspace-session lifetime.

Transactions are scoped by canonical workspace root, not only workspace id,
because workspace ids can be recreated after restart while the filesystem root
remains the recovery boundary.

The store should expose narrow operations such as:

- create preparing transaction;
- mark prepared;
- mark committing;
- mark committed;
- mark recovery required with diagnostic detail;
- list unresolved transactions;
- delete resolved transaction;
- close.

The database migration should add a dedicated patch-transaction table. Payload
JSON is acceptable for the per-path manifest in the first version because the
transaction is always loaded/reconciled as a whole; stable indexed columns
should still include transaction id, root, state, created time, and updated
time.

The first migration shape should use a new schema version rather than rewriting
prior migration history. Because this is a fork-local capability, use a
reserved high-number extension range rather than consuming upstream's next
sequential migration number; this keeps future upstream v9/v10-style migrations
mergeable without rewriting an already-applied local database history.

## Runtime integration shape

Keep the patch engine testable and avoid a global database singleton.

Recommended composition:

- a `PatchTransactionStore` owns SQLite persistence;
- a `PatchRecoveryManager` owns startup reconciliation, unresolved-root
  checks, cleanup, and CLI inspection/resolution;
- `applyPatch(...)` receives a narrow journal/coordinator dependency through
  its existing options/dependency boundary rather than importing the store;
- the Codex tool handler checks the canonical workspace root for unresolved
  recovery state before entering the patch engine and returns
  `PATCH_RECOVERY_REQUIRED` when blocked.

The production server may open its own recovery manager/store for normal patch
journaling. The pre-listen startup gate may use a short-lived manager/store to
reconcile and close before `createServer(...)`; SQLite WAL permits these
sequential connections without making the synchronous server factory async.

Tests may inject an in-memory/fake journal into the patch engine while
store/restart tests use the real SQLite implementation.

## Startup integration

Production `devspace serve` runs through `src/cli.ts`, which already performs
pre-listen managed-worktree cleanup.

Recommended order:

1. load config;
2. run patch-transaction recovery;
3. run managed-worktree cleanup;
4. create MCP server;
5. listen.

The direct `src/server.ts` main entry, if kept as a supported executable path,
must invoke the same startup recovery gate before listening. The recovery logic
should live in a reusable module rather than being duplicated in CLI code.

Unit-level `createServer(...)` remains synchronous; recovery belongs to the
outer startup lifecycle and does not require converting the server factory to
async.

## Process-crash testing

Tests should not simulate crash recovery only by throwing ordinary exceptions;
the existing transaction tests already cover that path.

Add child-process fault-injection tests that:

1. create an isolated workspace and state directory;
2. start a small child process that invokes the patch publication path;
3. terminate the child after a controlled publication milestone using a
   test-only hook or environment-gated crash point;
4. start recovery in a fresh process;
5. verify the expected filesystem and journal state.

Required scenarios:

- crash after journal `prepared`, before mutation → originals preserved;
- crash after first of multiple publications → all originals restored;
- crash after all publications but before `committed` marker → rollback to
  originals;
- crash after `committed` marker but before cleanup → published state kept,
  leftovers cleaned;
- external change after crash before restart → no automatic overwrite,
  `recovery_required`;
- missing/corrupt recovery file → `recovery_required`;
- unrelated workspace remains patchable while one root is blocked;
- successful normal patch leaves no journal rows or recovery artifacts.

## Power-loss durability

SQLite currently uses WAL mode with `synchronous = NORMAL`. Same-directory
temporary files are not fsynced as part of the patch contract.

That is sufficient for a process-crash/restart recovery design but is **not**
enough to promise persistence ordering across sudden power loss.

A future power-loss-durable phase would need explicit decisions for:

- file fsync;
- directory fsync after rename/create/delete;
- SQLite synchronous mode and transaction boundaries;
- Windows flush semantics;
- ordering between journal durability and project-filesystem durability when
  `stateDir` and the workspace live on different filesystems.

That stronger guarantee should not be implied by the first recovery phase.

## Empty parent-directory boundary

The first recovery implementation journals file states and transaction-owned
files, not durable provenance for parent directories created while preparing a
new nested target.

After a process crash, an empty parent directory may therefore remain even
after all project files are restored. Startup recovery must not delete an empty
directory merely because it did not exist when the patch began: after restart
DevSpace cannot prove that another local process did not create that directory.

This is a bounded cleanup limitation, not permission to overwrite or delete
ambiguous external state.

## Implementation scope checkpoint

Unlike the previous hardening phases, this design necessarily spans:

- patch engine publication;
- a new persistent store;
- DB schema/migration;
- server startup lifecycle;
- structured error taxonomy;
- CLI administration;
- child-process crash tests;
- docs/runtime contract.

This is a genuine cross-module production implementation. Finish design review
before implementation and treat any attempt to add power-loss durability or a
model-facing recovery tool as scope expansion requiring a new decision.

