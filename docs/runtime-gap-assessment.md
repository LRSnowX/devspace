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

## Priority 1: crash-safe patch recovery

Transactional publication currently restores changes after catchable failures
while DevSpace remains alive. It is not crash-safe.

A process or machine failure during multi-file publication can leave partial
state or same-directory recovery files. Solving this correctly requires a
persistent transaction journal, recovery protocol, startup reconciliation, and
cross-platform tests. This is materially larger than ordinary patch hardening
and should not be implemented without a separate design review.

The design review is now captured in
[Patch crash recovery design](patch-crash-recovery-design.md). The first
implementation should target process-crash/service-restart recovery only, not
power-loss durability.

## Priority 2: structured errors for the remaining coding surface

Codex `apply_patch` has a host-compatible structured domain-error contract.
Other tools still use legacy thrown errors for many expected failures, such as
missing/invalid project entry, unauthorized Memory thread expansion, missing
files, or process-session misuse.

Extending the taxonomy would improve model self-correction, but it is primarily
an ergonomics and reliability improvement rather than a current data-integrity
gap.

## Priority 3: persistent metadata retention

Workspace sessions, conversation bindings, and review refs do not yet have a
general retention policy. Their persistent stores can grow over long-lived
installations.

This is not the same as process-session leakage: completed process sessions are
removed and also have a bounded completion TTL. Persistent metadata retention
should be handled by a product-level policy rather than ad hoc deletion.

## Deliberate non-goals

- Shell commands continue to run with the local user's authority; DevSpace is
  not a filesystem sandbox.
- The repeat-failure circuit remains process-local and exact-request-only.
- Multi-file patch publication is not database-style atomic visibility.
- CHIM project relevance remains heuristic; thread expansion authorization is
  the security boundary DevSpace adds on top.
