# Runtime gap assessment

This assessment follows the Runtime Contract, transactional `apply_patch`,
file revisions, structured patch errors, and repeat-failure circuit breaker.
It records the remaining gaps by value rather than treating every limitation as
the next feature.

## Completed after this assessment: absence precondition for add/overwrite paths

Current Codex patch semantics intentionally allow `*** Add File:` to overwrite
an existing file. Content revisions protect files that were successfully read,
but there is no equivalent precondition for "this path must still be absent".

That leaves a real race:

1. the caller plans to create a new path;
2. another process creates that path first;
3. the later `Add File` patch can overwrite the new file unless the caller has
   another explicit precondition.

DevSpace now exposes optional `expected_absent_paths`. It preserves existing
Add File overwrite compatibility for callers that omit the precondition while
allowing intended-new paths and move destinations to fail closed when another
writer creates the path first.

## Completed after this assessment: process-crash patch recovery

Transactional publication originally restored changes only after catchable
failures while DevSpace remained alive.

DevSpace now journals patch transactions in the local state database, keeps
same-directory recovery material, reconciles interrupted transactions before
`devspace serve` listens, and degrades safely to `recovery_required` when
automatic restoration cannot be proven safe.

This guarantee is deliberately limited to process-crash/service-restart
recovery. Power-loss durability, fsync ordering, and distributed multi-process
locking remain out of scope. See
[Patch crash recovery design](patch-crash-recovery-design.md).

## Completed after this assessment: structured process-session errors

Codex process tools now return ordinary structured domain results for expected
session-lifecycle misuse instead of turning those cases into connector
exceptions. Missing sessions, cross-workspace session access, and PTY-only
resize requests have stable error codes. Normal non-zero or signaled process
exits remain completed command results rather than tool errors.

## Completed after this assessment: structured read path errors

The common `read` tool now returns ordinary structured domain results for
missing workspaces, workspace/skill scope violations, and filesystem
`ENOENT`/`ENOTDIR` reads. Missing files use `FILE_NOT_FOUND`; successful
reads still return a complete-file revision for stale-read protection. Other
upstream read failures remain unclassified unless DevSpace has a typed signal,
avoiding brittle message parsing.

## Completed after this assessment: structured Claude mutation path errors

Claude `write` and `edit` now return ordinary structured domain results for
typed workspace/path failures. `edit` also reports a missing target as
`FILE_NOT_FOUND` using filesystem errno classification. Upstream edit
semantics such as zero matches, multiple matches, and overlapping replacements
remain unclassified because the dependency currently exposes them only as
human-readable errors.

## Completed after this assessment: structured project-entry errors

`open_workspace` now returns ordinary structured domain results for unknown
project names, ambiguous project names, targets that are not directories, and
typed allowed-root scope violations. Ambiguous entries include sorted candidate
paths so the caller can retry with an absolute path. Successful opens use
`status: "opened"`; expected project-entry failures use `status: "error"`.

The output stays a single host-compatible object envelope rather than a union
schema because the current MCP Apps registration/adapter path does not preserve
successful `structuredContent` reliably with the union form. Git/worktree
semantics remain outside this slice unless they expose a stable typed signal.

## Completed after this assessment: structured Memory authorization errors

`memory_get_thread` now returns `MEMORY_THREAD_NOT_AUTHORIZED` as an ordinary
structured domain result when a conversation/evidence ID was not discovered for
the current project. The payload includes `conversation_id` and is retryable
only after project-scoped discovery. Both Memory tools also preserve existing
typed workspace lifecycle failures as domain results. CHIM failures themselves
remain untouched.

## Priority 1 complete: structured first-party expected failures

`open_workspace` project entry, local Memory authorization/workspace failures,
`read`, Claude mutation path failures, Codex `apply_patch`, and
process-session misuse now have a host-compatible structured domain-error
contract. Dependency-owned tool semantics without a stable typed signal remain
intentionally unclassified.

Extending the taxonomy would improve model self-correction, but it is primarily
an ergonomics and reliability improvement rather than a current data-integrity
gap.

## Priority 2 observation phase: persistent metadata retention

Stale workspace metadata now has a conservative product policy:

- devspace retention inspect reports safe metadata candidates idle for more
  than 90 days;
- devspace retention prune explicitly removes eligible checkout sessions and
  pruned managed-worktree sessions that have neither recovery metadata nor a
  recovery ref;
- conversation bindings and loaded-agent-file state cascade with the session;
- matching review refs are cleaned best-effort;
- roots protected by unresolved patch recovery are skipped;
- recoverable or unverifiable pruned worktree sessions are protected;
- deletion rechecks lifecycle state in SQLite so a concurrently reused or
  reactivated candidate is skipped;
- no automatic startup retention is enabled.

This addresses the safe monotonically growing workspace classes without
mixing retention with recoverable worktree state.

Managed-worktree recovery refs now retire best-effort after a pruned worktree
has been restored and its persisted session has successfully returned to the
active state. Cleanup deliberately happens after reactivation so a persistence
failure cannot destroy the only recovery anchor.

The remaining retention question is aged pruned worktrees that are never
restored. Their session plus refs/devspace/recovery/<workspace-id> may be the
only surviving copy of isolated work. Any policy that discards that state must
therefore be explicit and recovery-aware; it is not suitable for automatic
startup TTL cleanup.

OAuth dynamic client registrations are a separate persistent-growth surface.
DevSpace now records oauth_clients.last_used_at and backfills existing clients
to the migration time so old registrations are not retroactively treated as
stale. Registration, client lookup, and successful token issuance refresh the
signal. No OAuth client deletion policy is enabled yet; expired access/refresh
tokens continue to use their existing cleanup path.

Local-agent sessions and turns are intentionally different from disposable
metadata. Their logical agent ids and provider session ids support explicit
continuation across daemon restarts, including from idle/error states. They are
therefore treated as user-owned durable history rather than age-based retention
candidates. A future lifecycle should be an explicit agents archive/delete
operation, not a background TTL.

Priority 2 is now in an observation phase rather than an unbounded-growth
blind spot: safe workspace metadata has explicit pruning, recoverable worktree
state is protected and self-cleans its recovery ref after restoration, OAuth
registrations have a last-used signal while deletion is deferred for evidence,
and local-agent history has an explicit retain-by-design policy.

Further runtime hardening should pause unless new evidence identifies a concrete
integrity or compatibility gap. Fork maintenance and early upstream-sync review
now take priority; see [Upstream maintenance](upstream-maintenance.md).

## Deliberate non-goals

- Shell commands continue to run with the local user's authority; DevSpace is
  not a filesystem sandbox.
- The repeat-failure circuit remains process-local and exact-request-only.
- Multi-file patch publication is not database-style atomic visibility.
- CHIM project relevance remains heuristic; thread expansion authorization is
  the security boundary DevSpace adds on top.
