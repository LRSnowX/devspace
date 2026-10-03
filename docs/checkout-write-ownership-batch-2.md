# Checkout write ownership: Batch 2 implementation candidate

This candidate consumes the frozen design and the accepted Host/core contract.
It is not real-host acceptance. There is no SQLite migration or automatic owner
selection, retry, expiry, takeover, scheduling, or recovery.

## Agent turns

The daemon uses `WriteOwnership` against the same configured `stateDir` as the
MCP server. `read_only` does not acquire ownership or create a mutation activity.
The internal daemon protocol is v6 so a new client cannot dispatch turns to a
pre-enforcement v5 daemon. Existing idle replacement behavior is unchanged;
active legacy daemons require their normal terminal/shutdown workflow before
using this candidate. No MCP Host schema or authorization rule changes.
`allowed`, `full_access`, and the omitted/default mode require ownership by the
originating workspace. An unscoped CLI mutation-capable invocation is rejected;
an explicitly read-only invocation retains its existing scope behavior.

Each mutation-capable turn gets one activity before provider execution. Polling,
waiting and continuation receipts do not create replacement activities. A normal
response or an acknowledged terminal failure/cancellation clears the exact
activity in manager cleanup. Transport errors, timeouts, process death and
unacknowledged cancellation do not prove terminal executor state: they retain
the activity. Restart reconciliation of agent rows does not reap ownership.

Codex/ACP/OpenCode adapters record their actual backend PID when available.
Opaque SDK runtimes retain incomplete evidence. Backend PIDs alone do not prove
that every provider/shell descendant has stopped; production provider evidence
therefore remains non-exhaustive. Interrupted turns may require manual operator
inspection rather than routine recovery, even when the daemon has died.

## Destructive retention

`write-ownership/<root-hash>.retention.json` is a strict version-1 guard record,
not a workspace owner. It stores canonical root, guard UUID, operation kind,
start time, executor PIDs/completeness and initial root device/inode (or absence).
Existing ownership JSON and its schema are unchanged.

Acquire and retention-start race under the same short filesystem transition
mutex. A live guard returns busy; corrupt, stale or unverifiable state requires
recovery. Git deletion, persistence and compensation execute outside that mutex,
while the guard remains published. Actual destructive Git/compensation PIDs are
added to the guard. Exhaustive descendant evidence is not claimed.

Normal deletion, safe skip, and successful persistence-failure compensation
remove only the exact inspected guard. Ambiguous deletion or failed compensation
retains it. Metadata retention uses the same guard in addition to its existing
transactional staleness checks. Review-ref cleanup changes executor completeness
to false before invoking external Git. Pruned-workspace restoration reserves
the same guard through reactivation and any delete-on-persistence-failure
compensation. It refuses an unresolved lifecycle and does not acquire ownership.

## Operator diagnostics and recovery

```text
devspace write-ownership list
devspace write-ownership show <project-or-path>
devspace write-ownership recover <project-or-path>
```

Names/aliases use the existing Project Registry. Paths, including missing managed
roots, are canonicalized and checked against configured project/worktree roots.
Diagnostics show claims, guards, active activities and undecodable artifacts.
They do not modify or discard state.

Recovery retains the accepted executor rules: idle claims can be cleared
explicitly; active state requires exhaustive evidence and all executors dead.
Guard recovery additionally requires a known-safe filesystem lifecycle. Metadata
guard recovery verifies the recorded root identity/absence. Routine CLI recovery
deliberately refuses managed-worktree guards: the current Git adapter cannot
prove exhaustive destructive descendants or safely classify partial deletion
after a crash. Those cases need manual inspection, not a force flag.

This is process-restart coordination only. It does not add power-loss durability,
fsync guarantees, PID birth-identity guarantees, or OS sandboxing of providers.
