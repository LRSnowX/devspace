# File revision design

This document defines the stale-read protection contract for DevSpace file
reads and Codex `apply_patch`.

## Goal

When a patch relies on a file version previously returned by `read`, callers
should be able to require that same version still exists when `apply_patch`
begins. If it changed, the patch must fail before publication.

## Revision token

A revision is:

`sha256:<64 lowercase hex characters>`

It is the SHA-256 digest of the file's complete raw byte content.

The token intentionally does not include:

- Git HEAD or index state;
- mtime, inode, or file size;
- workspace identity;
- the requested read offset/limit.

Two paginated reads of the same unchanged file therefore return the same
revision.

## Read contract

Every successful `read` returns `revision` in structured output.

The revision is computed from the same full-file Buffer consumed by the Pi read
primitive, so it identifies the version that produced the returned text/image
rather than a second independent filesystem read.

For text pagination, the output may contain only a range of lines while the
revision still identifies the entire file.

## apply_patch contract

`apply_patch` accepts optional:

```text
expected_revisions: [
  { path: "relative/path.txt", revision: "sha256:..." }
]
```

Each entry is workspace-relative and must refer to a path touched by the patch.
The path is validated with the same workspace confinement rules as patch paths.

When an expectation is supplied, DevSpace validates it on the path's first
touch while building the staged logical view. A mismatch fails before
publication.

Expected revisions are per path, not one workspace-wide revision. This matters
for multi-file patches and move destinations.

## Compatibility

`expected_revisions` is optional. Existing callers that do not yet send
revisions keep current patch semantics.

Callers should send the revision returned by `read` whenever a patch depends on
that earlier read. Add-only paths that were never read do not require an
expectation.

This phase does not add an "absent path" revision token.

## Relationship to transactional publication

Revision validation and transactional publication protect different windows:

- expected revisions protect `read -> later apply_patch`;
- the patch engine's first-touch baseline checks protect
  `apply_patch staging -> publication`;
- transactional rollback protects failures after publication has begun.

All three remain necessary.

## Errors

Revision conflicts use the current tool error channel. A unified structured
error taxonomy remains a later concern.

## Non-goals

This phase does not:

- make shell/write/edit tools revision-aware;
- introduce a new model-facing tool;
- bind revisions to Git commits;
- provide path-absence revisions;
- provide distributed locking across multiple DevSpace processes.
