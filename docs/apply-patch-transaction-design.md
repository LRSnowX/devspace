# Transactional apply_patch design

This document is the implementation preflight for strengthening DevSpace's
`apply_patch` publication semantics. It separates in-call transaction safety
from a future model-visible stale-read contract.

## Goal

When `apply_patch` fails during a normal running DevSpace process, it should
either:

- publish the complete staged patch; or
- restore every touched file to its state at the start of that apply call.

The existing parse, path-confinement, staged logical view, patch result, file
mode, and line-ending behavior must remain compatible.

## Non-goals

This phase does not add:

- a model-facing revision or `expected_revision` field;
- protection against a file changing after an earlier `read` but before the
  later `apply_patch` call begins;
- process-crash or power-loss recovery;
- isolation from other processes observing temporary commit-state changes;
- a new model-facing tool or structured error taxonomy.

Those are separate contracts.

## Failure model

### Before publication

Parsing, path validation, source reads, hunk application, final-content
preparation, and temporary-file writes happen before destructive publication.
Any failure in this phase must leave existing files unchanged. Temporary files
and directories created only for preparation should be cleaned up.

### During publication

Publication may fail because of permissions, filesystem errors, locks, full
storage, or another process changing a touched path.

Before replacing originals, DevSpace re-checks the first-touch baseline for all
touched paths. This only detects changes that happen during the current
`apply_patch` call; it is not the future stale-read contract.

For publication, DevSpace prepares same-directory rollback copies from each
first-touch baseline and same-directory temporary files for final content.
Targets are revalidated immediately before each mutation. Prepared final files
are then renamed into place using the existing single-file replacement
semantics; deletes remove the target only after its baseline is revalidated.

If publication fails, DevSpace reverses the transaction:

1. walk successfully mutated paths in reverse order;
2. confirm each path still contains the state published by this apply call;
3. restore the prepared first-touch baseline, or remove a file that was absent
   at first touch;
4. remove unused prepared temporary files;
5. remove empty directories created only by this transaction where safe.

If rollback itself fails, the original publication error and the rollback
failure must both be surfaced. DevSpace must not overwrite a newer external
change merely to make rollback succeed. Unused rollback files should be
retained where possible for manual recovery.

## Transaction boundary

The transaction covers filesystem file-state mutations made by one
`apply_patch` call.

It guarantees an all-or-restored outcome only for failures DevSpace can catch
while the process remains alive and rollback succeeds.

It does not provide database-style atomic visibility. Other processes may
observe intermediate states while different paths in a multi-file patch are
being published or rolled back.

It is also not crash-safe. A process crash or machine failure during commit may
leave transaction backup or prepared files that require later recovery work.

## Baseline semantics inside one apply call

The staged logical view should record each physical path's original state on
first touch:

- absent; or
- UTF-8 file content plus file mode.

Before commit, DevSpace compares the current state with that first-touch
baseline. A mismatch is a conflict and publication does not begin. Each path is
checked again immediately before its mutation, so a conflict detected after
earlier paths were published triggers rollback.

This closes the race between staging and publication within one
`apply_patch` invocation.

It does **not** close this race:

`read -> user/tool changes file -> later apply_patch`.

That requires a model-visible revision contract.

## Future stale-read contract

A later phase should make stale-read protection explicit rather than infer it
from patch context.

The intended shape is:

- successful `read` exposes a stable content revision token in structured
  output;
- `apply_patch` can receive expected revisions for the files whose prior
  reads the patch relies on;
- a mismatch fails before publication with a conflict result;
- revisions describe file content identity, not workspace Git HEAD.

Multi-file patches require per-path expected revisions rather than one global
workspace revision.

The existing accepted-but-ignored Codex `*** Environment ID:` patch header is
not a revision contract and should remain unrelated unless a real host
compatibility requirement establishes otherwise.

## Cross-platform publication

Prepared files and rollback copies should live beside their destinations so rename
operations stay on the same filesystem as the target path.

This avoids depending on cross-device rename behavior and keeps the existing
single-file replacement behavior available on Windows as well as POSIX
platforms.

Case-only moves must preserve the existing `isSamePatchFile` behavior and be
tested on platforms where the source and destination may identify the same
file.

## Test plan

Tests should cover:

- preparation/hunk failure publishes nothing;
- failure while backing up a later file restores earlier backups;
- failure while publishing a later file removes already-published finals and
  restores all originals;
- overwrite, delete, and move destinations are restored exactly;
- new files created before rollback are removed;
- staged logical view semantics remain unchanged;
- mode and CRLF behavior remain unchanged;
- a path changed between first touch and commit is rejected before destructive
  publication;
- rollback failure is surfaced distinctly from successful rollback.

Fault injection should be an internal/test seam around filesystem publication,
not a model-facing option.

## Implementation scope

The expected production change is local to the patch engine plus focused
tests, with a corresponding Runtime Contract update after verification.

If implementation requires broader workspace, MCP schema, persistence, or
cross-module redesign, stop and reassess before expanding scope.
