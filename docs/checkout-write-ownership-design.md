# Checkout Write Ownership — Checkpoint A Formal Design

Status: **design only**. This document freezes the intended product contract for
the first writer-ownership checkpoint. It does not describe behavior that is
already implemented.

## Problem

DevSpace intentionally gives different host conversations different
`workspace_id` values. In checkout mode, those workspaces may still resolve to
the same physical checkout.

That means two otherwise independent host conversations can currently do this:

```text
conversation A -> workspace A --\
                               +-> /Users/example/project
conversation B -> workspace B --/
```

Both workspaces are valid. Both may inspect the project. Today both may also
mutate the same physical checkout.

This creates an evidence and safety problem. A host may start reviewing or
testing candidate A while another host, shell process, or write-enabled
subagent changes the checkout to candidate B. The later validation output is
then no longer evidence for the same repository state that the review began
against.

The solution is not to collapse conversations into one workspace. Separate
workspace identity is still useful. The missing primitive is explicit write
ownership for the physical canonical root.

## Product principles

This checkpoint must preserve the DevSpace product model:

1. **The host remains the orchestrator.** DevSpace does not decide which
   conversation is more important, queue writers, transfer ownership
   automatically, or choose a worktree on the host's behalf.
2. **Write ownership is a safety primitive, not a scheduler.** The host
   explicitly acquires and releases it.
3. **Read access remains composable.** Multiple workspaces may inspect the same
   checkout while one workspace owns write authority.
4. **Parallel mutation uses isolated worktrees.** A second writer should use a
   separate canonical root rather than relying on hidden concurrency inside one
   checkout.
5. **State and failure are inspectable.** Ownership, an active mutation, and
   recovery-required state are explicit structured state.
6. **No hidden timeout transfers authority.** Ownership never changes because a
   TTL expired, a workspace has been idle, or another conversation appears.
7. **Adapters stay at the edges.** Provider-specific subagent behavior consumes
   the same generic ownership contract instead of defining its own ownership
   model.

## Terminology

**Canonical root**

The canonical filesystem root already resolved by `WorkspaceRegistry`.
Equivalent path and symlink aliases must map to the same ownership key.

**Write ownership**

An explicit reservation of one canonical root by one `workspace_id`.
Ownership allows that workspace to begin mutation-capable operations. It does
not itself mean that an operation is currently running.

**Active mutation**

One currently running operation that may mutate the canonical root. A
write-owning workspace may have multiple active mutations when the host chooses
to run them concurrently. DevSpace records those activities so ownership cannot
be released while work is still capable of changing the checkout.

**Read operation**

A DevSpace operation whose implementation is known to be read-only, such as
the structured file read surface, repository-state inspection, memory
retrieval, or change inspection.

**Mutation-capable operation**

An operation that writes the workspace or has local-user shell/provider
authority that can write it. Checkpoint A treats arbitrary shell execution as
mutation-capable because DevSpace cannot prove an arbitrary shell command is
read-only.

## Authority key

Ownership is keyed by `workspace.canonicalRoot`, not by:

- conversation ID;
- project name;
- non-canonical input path;
- `workspace_id` alone.

Different worktrees have different canonical roots and therefore independent
ownership.

If the same physical root is opened through multiple aliases, all aliases
compete for the same ownership.

## Host-facing contract

Checkpoint A adds two model-facing primitives and no autonomous workflow.

### `acquire_write_ownership`

Input:

```text
workspace_id
```

Behavior:

- resolve and validate the workspace normally;
- derive its canonical root;
- fail closed if that root is in unresolved ownership recovery;
- if destructive retention currently holds a live guard for the root, return
  `WRITE_OWNERSHIP_BUSY` without waiting;
- if the destructive-retention guard is stale, corrupt, or cannot be verified
  safely, return `WRITE_OWNERSHIP_RECOVERY_REQUIRED`;
- if unowned, assign ownership to this workspace;
- if already owned by this workspace, succeed idempotently;
- if owned by another workspace, return a structured conflict;
- never wait, queue, steal, or transfer ownership automatically.

Successful status:

```text
acquired
already_owned
```

The model does not need an internal claim token or state-file path.

### `release_write_ownership`

Input:

```text
workspace_id
```

Behavior:

- if this workspace owns the canonical root and there are no active mutations,
  release it;
- if no ownership exists, succeed idempotently as `not_owned`;
- if another workspace owns it, return a structured conflict;
- if an active mutation exists, return a structured busy result and keep
  ownership unchanged;
- never kill a process, cancel a subagent, or force another owner to release.

Successful status:

```text
released
not_owned
```

### `open_workspace` visibility

`open_workspace` should expose a compact, point-in-time ownership snapshot:

```json
{
  "write_ownership": {
    "state": "unowned | owned_by_workspace | owned_by_other | recovery_required",
    "owner_workspace_id": "optional",
    "active_mutation_count": 0
  }
}
```

This snapshot is informational and may become stale immediately. Every
mutation-capable operation must re-check authoritative ownership state.

The snapshot describes **write ownership**, not every root-lifecycle blocker.
Checkpoint A does not add a `retention_in_progress` model-facing ownership
state. A root may therefore be ownership-`unowned` while a short-lived
destructive-retention guard makes a subsequent acquire return
`WRITE_OWNERSHIP_BUSY`. This keeps lifecycle exclusion separate from the Host
ownership model.

The model-facing instruction should stay short:

> Acquire write ownership before mutation-capable work; release it when the
> mutation phase is complete. Ownership conflicts are decisions for the host,
> not for DevSpace.

## State model

For each canonical root, the persisted state is conceptually:

```text
unowned
  |
  | acquire(workspace A)
  v
owned(workspace A)
  |
  | begin mutation
  v
owned(workspace A) + active mutation(s)
  |
  | all mutations complete/fail/cancel
  v
owned(workspace A)
  |
  | release
  v
unowned
```

There is no ownership TTL.

There is no automatic owner transfer.

Read operations remain available while ownership or an active mutation exists.

## Why ownership and active-mutation tracking are separate

The host may intentionally reserve a checkout across a coherent development
phase:

```text
acquire
  -> edit
  -> read/review
  -> test
  -> read/review
  -> edit
release
```

Requiring a new ownership race between every operation would make a coherent
phase fragile.

Active-mutation tracking serves a different purpose. DevSpace must know whether
the owner still has work in flight before it can safely release ownership:

```text
exec_command -> session still running
write-enabled subagent -> turn still running
```

Checkpoint A does **not** serialize those operations inside the owning
workspace. The host remains responsible for deciding whether two operations
from the same workspace should run concurrently. Existing file revision,
transaction, provider, and process contracts continue to detect the conflicts
they already know how to detect.

This distinction is intentional:

- DevSpace prevents a second workspace from becoming a concurrent writer;
- DevSpace prevents release while the current owner still has mutation-capable
  work running;
- DevSpace does not become an intra-workspace scheduler.

## Mutation enforcement matrix

The following host-facing operations require ownership. Each running operation
is registered as an active mutation for lifecycle/recovery purposes:

| Surface           | Operation                         | Checkpoint A treatment                   |
| ----------------- | --------------------------------- | ---------------------------------------- |
| Codex-compatible  | `apply_patch`                     | mutation-capable                         |
| Codex-compatible  | `exec_command`                    | mutation-capable for every shell command |
| Claude-compatible | `write`                           | mutation-capable                         |
| Claude-compatible | `edit`                            | mutation-capable                         |
| Claude-compatible | `bash`                            | mutation-capable for every shell command |
| Local agent       | turn with `writeMode=allowed`     | mutation-capable                         |
| Local agent       | turn with `writeMode=full_access` | mutation-capable                         |
| Local agent       | turn with `writeMode=read_only`   | read-only                                |

The existing local-agent default currently resolves to `allowed`; omission of
`writeMode` therefore cannot bypass ownership.

Known read-only surfaces do not require ownership, including:

- `open_workspace`;
- structured file `read`;
- repository-state reads;
- memory search/thread retrieval;
- `show_changes`;
- skill and instruction reads;
- other operations whose implementation has an explicit read-only contract.

## Shell boundary

DevSpace shell execution runs with the local user's authority and is not a
filesystem sandbox. A string classifier cannot reliably prove that:

```bash
git status
```

is harmless while every possible shell construct remains harmless.

Checkpoint A therefore does **not** add a regex, model, allowlist, or heuristic
command classifier. All arbitrary shell execution is mutation-capable.

This still does not make shell execution a sandbox. A shell started for one
workspace can technically address paths outside that workspace using the
user's local authority. Write ownership is a coordination boundary between
well-behaved DevSpace operations, not a replacement for OS sandboxing or the
existing allowed-root security model.

## Active mutation lifecycle

Each active mutation record must cover the complete period during which that
operation can affect the checkout.

### Synchronous file mutation

`apply_patch`, `write`, and `edit`:

```text
begin active mutation
  -> execute mutation
  -> end active mutation in finally
```

Publication/recovery failures do not silently transfer ownership.

### Shell process

For `exec_command`, the active mutation begins before process start and remains
active when the initial call returns a `session_id`.

It ends only when the underlying process actually exits or definitively fails
to start.

Polling or replaying a completed process result is not a new mutation.

Sending Ctrl-C or termination does not release the active mutation until the
process has actually reached a terminal state.

The Claude `bash` surface holds the active mutation for the entire synchronous
shell call.

### Local-agent turn

A write-enabled local-agent turn begins an active mutation before provider
execution and releases it in the manager's terminal cleanup path.

The mutation spans the entire turn, not only individual provider tool calls,
because DevSpace cannot safely observe every provider-internal write boundary.

Read-only agent turns do not require or consume write ownership.

## Cross-process requirement

The MCP server and local-agent daemon are separate processes. Ownership cannot
be process-local memory.

Checkpoint A uses one small fork-local ownership store under DevSpace
`stateDir`, shared by the MCP server and agent daemon.

It must not require a new upstream SQLite migration.

Conceptually:

```text
<stateDir>/
  write-ownership/
    <canonical-root-hash>.json
    <canonical-root-hash>.mutex
    <canonical-root-hash>.retention.json
```

The concrete filenames are implementation details and are not exposed as model
choices.

The optional retention record is a **destructive-retention guard**, not a
second owner. It exists only while retention is performing a destructive
filesystem lifecycle operation on that canonical root. Its purpose is to close
the cross-process race between "verified unowned" and an asynchronous worktree
deletion without holding the transition mutex for the duration of that
deletion.

Conceptually, the guard records only the information needed to identify the
root, the exact guard instance, the destructive operation, its start time, and
executor-liveness evidence. It does not contain a workspace owner and is not a
model-facing authority state.

The persisted record includes only state needed for coordination and
diagnostics, conceptually:

```json
{
  "schema_version": 1,
  "canonical_root": "/canonical/project/path",
  "owner_workspace_id": "ws_...",
  "acquired_at": "...",
  "active_mutations": [
    {
      "activity_id": "...",
      "kind": "shell_process | apply_patch | write | edit | subagent_turn",
      "started_at": "...",
      "executor_processes": [12345]
    }
  ]
}
```

Internal nonces or activity IDs may be used for correctness but are not part of
the model-facing contract. Process identifiers are recovery evidence, not a
model-facing ownership API.

## Atomicity

All operations that change ownership state or active-mutation state must be
serialized by a short-lived per-canonical-root filesystem mutex.

The mutex is **not** write ownership. It protects state transitions only.

Required atomic transitions include:

- acquire ownership;
- release ownership;
- begin active mutation;
- end active mutation;
- operator recovery;
- begin destructive retention;
- end destructive retention.

The mutex remains short-lived. In particular, retention **must not** hold the
transition mutex across `git worktree remove`, recursive filesystem removal,
provider execution, or any other long-running asynchronous operation.

Instead, destructive retention uses this sequence:

1. under the root transition mutex, verify that the root has no ownership,
   active mutation, or existing destructive-retention guard;
2. atomically publish a guard for that exact canonical root and release the
   mutex;
3. perform the destructive retention operation without holding the mutex;
4. on a known-safe terminal outcome, reacquire the mutex and remove only the
   exact guard instance that started the operation.

`acquire` and `beginMutation` check for a destructive-retention guard under the
same root mutex. Therefore acquisition and destructive-retention start race as
one atomic decision: exactly one side may proceed.

A live guard makes new mutation authority temporarily unavailable. DevSpace
does not wait or queue for it. A stale, corrupt, or executor-ambiguous guard
fails closed and requires operator recovery; it is never removed merely because
it is old.

The implementation should reuse the existing daemon-lock design principles:

- publish owner metadata atomically;
- do not expose an empty or partially written ownership record;
- use restrictive state-directory/file permissions;
- fail closed on undecodable state;
- stale recovery must move/remove the exact state inspected, never delete a
  replacement published by another contender.

The persisted ownership record itself must be updated with atomic replacement
under the mutex.

## Error contract

Checkpoint A adds typed errors to the common tool-error contract:

### `WRITE_OWNERSHIP_REQUIRED`

- category: `state`
- retryable: `true`
- meaning: a mutation-capable operation was requested without ownership;
- host action: acquire ownership, choose an isolated worktree, or abandon the
  mutation.

### `WRITE_OWNERSHIP_CONFLICT`

- category: `conflict`
- retryable: `true`
- meaning: another workspace currently owns the same canonical root;
- includes `owner_workspace_id`;
- DevSpace does not wait or transfer ownership.

### `WRITE_OWNERSHIP_BUSY`

- category: `conflict`
- retryable: `true`
- meaning: the requested ownership/lifecycle transition cannot proceed because
  active mutation-capable work or a live destructive-retention guard is still
  in progress;
- may include active mutation kinds, count, and start times;
- does not create a wait/queue and does not transfer authority;
- an owner's existing right to start another same-owner mutation is unchanged
  unless destructive retention already holds the root guard.

### `WRITE_OWNERSHIP_RECOVERY_REQUIRED`

- category: `recovery`
- retryable: `false`
- meaning: persisted ownership state is ambiguous, corrupt, or contains stale
  mutation/retention evidence that DevSpace cannot safely resolve
  automatically;
- host action: stop mutation and use explicit operator recovery.

Existing workspace/path/recovery errors keep their existing meaning. Acquiring
write ownership does not override:

- `WORKSPACE_INVALIDATED`;
- allowed-root containment;
- `PATCH_RECOVERY_REQUIRED`;
- file revision/path-state preconditions;
- patch rollback/recovery safety.

## Conflict behavior

When another workspace owns the root, DevSpace returns structured state and
stops.

The host may then decide to:

- keep working read-only;
- wait and retry later;
- ask the user whether the previous writer is finished;
- open an isolated worktree;
- use operator recovery when ownership is genuinely stale.

DevSpace must not:

- automatically queue the request;
- automatically poll for release;
- cancel the current owner;
- transfer ownership to the newer conversation;
- choose a worktree automatically;
- infer that an older conversation is less important.

## Restart semantics

Ownership survives MCP-server restart because the store is persistent.

Active mutation records also survive process restart. This is intentional:
after an abnormal exit DevSpace must not assume that mutation-capable work
completed safely.

A normal operation removes its active mutation in a terminal cleanup path.

Server restart therefore has two safe outcomes:

- ownership with no active mutation remains owned and may be released by the
  same workspace after reconnect; or
- interrupted active mutations remain visible and require recovery if their
  executors cannot prove a clean terminal transition.

No age-based cleanup is permitted.

## Operator recovery

Stale ownership recovery is operator-facing, not a model-facing takeover tool.

Checkpoint A should provide CLI diagnostics conceptually equivalent to:

```text
devspace write-ownership list
devspace write-ownership show <project-or-path>
devspace write-ownership recover <project-or-path>
```

`recover` may clear an abandoned claim when there is no active mutation.

If active mutation records exist, safe recovery may clear them only when every
recorded executor that could still mutate the checkout is demonstrably no
longer alive. A live executor causes recovery to refuse. If DevSpace cannot
reliably identify or verify all relevant executors, recovery also refuses and
leaves the state for manual inspection.

For an external shell/provider process, recording only the MCP-server or
agent-daemon PID is insufficient: that parent may die while a child remains
alive. Implementations must record the actual mutation-capable executor process
where it is available, and fail closed when executor liveness is ambiguous.

An undecodable/ambiguous record fails closed. Checkpoint A does not expose a
model-facing force takeover and does not add a routine `--force-active`
escape hatch.

The same operator surface also diagnoses destructive-retention guards. A live
retention executor makes recovery refuse. A dead executor is not by itself
sufficient: recovery may clear the guard only when the root lifecycle can be
classified as safe and the recorded executor evidence is complete enough to
exclude a still-running destructive child. If the worktree deletion may be
partial, executor evidence is incomplete, or filesystem identity is ambiguous,
recovery leaves the guard in place for manual inspection.

Manual intervention remains possible for an operator after inspecting the
state, but that is outside normal model workflow.

## Worktree behavior

Worktrees participate in the same canonical-root ownership mechanism.

Because a managed worktree has its own root:

```text
checkout root A  -> ownership A
worktree root B  -> ownership B
worktree root C  -> ownership C
```

independent worktrees can mutate in parallel.

DevSpace does not auto-acquire ownership merely because it created a worktree.
The host still explicitly decides when that workspace enters a mutation phase.

This makes worktrees the explicit parallel-writer primitive rather than adding
hidden same-checkout concurrency.

## Interaction with patch recovery

Patch transaction recovery and write ownership solve different problems:

- patch recovery protects atomic publication/restart safety for one patch;
- write ownership coordinates mutation authority across workspaces/processes.

Existing safe startup patch recovery runs before normal model mutation and
keeps its existing fail-closed contract.

If a root has unresolved `PATCH_RECOVERY_REQUIRED` state, acquiring ownership
does not make that root writable. The patch-recovery blocker remains
authoritative.

The implementation must test restart ordering so ownership state never causes
an interrupted patch transaction to be silently accepted.

## Interaction with retention and workspace lifecycle

Persistent workspace records are not evidence of a live writer and never
receive ownership automatically.

An inactive/stale workspace record does not automatically release ownership.

Managed-worktree retention must not delete a root while that root has active
write ownership or an active mutation. A stale ownership claim must be
recovered explicitly before destructive retention of that root.

A pre-delete ownership check by itself is insufficient because another process
could acquire ownership after the check and before asynchronous deletion. For
managed-worktree deletion, retention must first publish the
destructive-retention guard described above under the same canonical-root
transition mutex used by ownership acquisition.

While that guard exists:

- ownership acquisition for the same canonical root is refused immediately;
- existing read-only metadata inspection may continue where the underlying root
  remains accessible;
- DevSpace does not auto-wait, auto-transfer authority, or create another
  worktree;
- normal completion or a known-safe skipped outcome removes the exact guard;
- a crash or ambiguous partial deletion leaves the guard fail-closed for
  explicit operator recovery.

The guard spans the destructive worktree lifecycle, including any compensation
needed to restore a worktree after persistence failure. It must not be cleared
between physical deletion and the terminal persistence/compensation outcome.

Metadata-only retention should continue to use its existing transactional
staleness checks. It must not delete the persisted workspace record that is the
current ownership claimant; if a metadata path can race with ownership without
such a transactional check, it must participate in the same destructive guard
protocol rather than adding a check-then-delete exception.

Workspace invalidation never retargets an existing ownership record to a new
filesystem identity.

## Security boundary

Write ownership does not broaden authority.

It does not:

- expand configured allowed roots;
- make shell execution sandboxed;
- permit a workspace to write paths that existing containment rejects;
- bypass provider permission modes;
- grant subagent authorization;
- authorize Codex/subagent invocation without the user's separate permission;
- replace revision/conflict checking inside file mutation tools.

It only adds a coordination precondition for mutation-capable DevSpace work.

## Upstream compatibility

This feature should remain a removable fork extension.

Requirements:

- no change to the upstream workspace identity model;
- no merging of conversation workspaces;
- no new upstream SQLite schema version solely for ownership;
- prefer a small independent state module under `stateDir`;
- keep tool-surface integration thin;
- keep provider-specific translation in local-agent adapters/manager;
- if upstream later ships equivalent checkout-write coordination, prefer
  migration to upstream and deletion of the fork-local mechanism.

The generic completed-session fixes remain independent of this checkpoint and
should not be coupled to ownership implementation.

## Required implementation seams

The implementation should introduce one generic ownership component rather
than scattering file-lock logic through handlers.

Conceptual interface:

```text
inspect(canonicalRoot, workspaceId)
acquire(canonicalRoot, workspaceId)
release(canonicalRoot, workspaceId)
beginMutation(canonicalRoot, workspaceId, kind)
endMutation(activity)
recover(canonicalRoot)
beginDestructiveRetention(canonicalRoot, kind)
endDestructiveRetention(guard)
```

Handlers consume this interface. They do not implement ownership policy
independently.

The destructive-retention seam is operator/lifecycle-facing, not model-facing.
It is a persisted exclusion reservation around root destruction, not write
ownership and not a scheduler.

The local-agent daemon and MCP server instantiate the same store contract
against the same `stateDir`.

## Test matrix

Checkpoint A is not accepted without all applicable cases below.

### Ownership identity

- same canonical root through two path aliases -> one ownership domain;
- two different project roots -> independent ownership;
- two managed worktrees -> independent ownership;
- checkout and worktree roots do not alias accidentally;
- same workspace acquiring twice -> idempotent `already_owned`;
- two workspaces racing to acquire -> exactly one succeeds.

### Ownership conflict

- workspace A owns; workspace B mutation -> `WRITE_OWNERSHIP_CONFLICT`;
- workspace B may still use known read-only surfaces;
- DevSpace does not auto-wait, auto-release, or auto-create a worktree;
- release by non-owner cannot clear A's ownership.

### Active mutation tracking

- owner may run multiple mutation-capable operations concurrently when the host
  intentionally chooses to do so;
- mutation from another workspace -> ownership conflict without execution;
- every in-flight mutation is recorded independently;
- release while any active mutation remains -> busy;
- one mutation completing removes only its own activity record;
- ownership remains until the owner explicitly releases it;
- read operations remain available while mutations are active.

### File tools

- `apply_patch` without ownership -> required;
- Claude `write` without ownership -> required;
- Claude `edit` without ownership -> required;
- each may run for the owner even when another owner-scoped mutation is active;
- mutation guard is released on normal failure as well as success;
- existing revision/path/recovery errors are preserved after ownership checks.

### Shell process

- `exec_command` without ownership -> required;
- arbitrary shell is never classified heuristically as read-only;
- running process holds active mutation after returning `session_id`;
- the owning workspace may intentionally start another mutation while it runs;
- another workspace remains blocked by ownership;
- completed process releases active mutation but retains completed-result replay;
- Ctrl-C/termination releases activity only after terminal process state;
- failed process start does not strand active mutation;
- Claude `bash` holds activity for the full call.

### Local agents

- `writeMode=read_only` does not require ownership;
- `writeMode=allowed` requires ownership;
- `writeMode=full_access` requires ownership;
- omitted/default write mode cannot bypass ownership;
- write-enabled turn holds the active mutation for the entire provider turn;
- other mutations from the owning workspace remain a host orchestration choice;
- another workspace remains blocked by ownership;
- provider failure/cancel/normal completion releases active mutation;
- daemon restart/crash leaves fail-closed recoverable state.

### Persistence / cross-process

- MCP server and agent daemon observe the same owner;
- server restart preserves ownership;
- restart never silently discards active mutation;
- concurrent state transitions from separate processes are atomic;
- corrupt/partial state -> recovery required, not deletion;
- secure file/directory permissions are enforced where supported.

### Destructive retention

- ownership A present -> retention cannot publish a destructive guard or delete
  the root;
- retention guard present -> ownership acquisition cannot succeed;
- acquire racing retention-start across separate processes -> exactly one wins;
- transition mutex is released before asynchronous deletion begins;
- normal deletion removes only its exact guard instance;
- a safe skipped cleanup removes its guard without changing ownership state;
- crash during deletion preserves the guard across restart;
- live/ambiguous destructive executor -> operator recovery refuses;
- ambiguous partial deletion -> operator recovery refuses;
- persistence failure followed by compensation keeps the guard until the
  compensation path reaches a terminal known-safe outcome;
- no age-based guard expiry, background takeover, or automatic retry is added.

### Recovery

- abandoned ownership with no active mutation can be operator-recovered;
- stale mutation with all relevant executors dead can be operator-recovered;
- a live or ambiguous mutation executor makes recovery refuse;
- undecodable mutation/claim state fails closed;
- recovery never removes a replacement record published by a race winner.

### Workspace lifecycle

- persistent second workspace binding alone is not a conflict;
- workspace invalidation does not transfer ownership;
- managed-worktree retention cannot delete a root with active ownership;
- managed-worktree retention and ownership acquisition have no check-then-delete
  race;
- worktree parallelism remains available through separate canonical roots.

### Real host path

- ChatGPT sees the compact ownership snapshot from `open_workspace`;
- ChatGPT can acquire, mutate, and release through the real MCP connection;
- a second ChatGPT conversation opening the same checkout receives a typed
  conflict instead of silently writing;
- choosing a worktree allows the second conversation to mutate independently;
- model-facing instructions remain compact and do not embed an autonomous
  workflow.

## Explicit non-goals

Checkpoint A does not implement:

- automatic owner selection;
- priority/fairness queues;
- intra-workspace mutation scheduling;
- wait-until-free background polling;
- lease TTLs or heartbeats;
- automatic ownership expiry;
- automatic force takeover;
- command-string read/write classification;
- shell filesystem sandboxing;
- merge of separate conversation workspaces;
- automatic worktree creation on conflict;
- cross-machine/distributed locking;
- user-visible multi-writer scheduling UI;
- a general transaction system for arbitrary shell effects.

## Acceptance criteria

Checkpoint A implementation is Repository Accepted only when:

1. ownership is keyed by canonical root and survives server restart;
2. one workspace owns a root at a time;
3. all mutation-capable work on a root belongs to that owning workspace;
4. active mutations are tracked independently without DevSpace scheduling
   same-owner execution;
5. mutation-capable host tools fail closed without ownership;
6. write-enabled local-agent turns obey the same ownership state;
7. read-only operations remain available to other workspaces;
8. worktrees provide independent parallel mutation roots;
9. long process sessions keep their mutation activity until actual process exit;
10. release is impossible while any active mutation remains;
11. stale/ambiguous state never transfers ownership automatically;
12. operator recovery is explicit and fail-closed;
13. no upstream SQLite migration is introduced for this fork-local feature;
14. no provider-specific ownership model leaks into the core domain contract;
15. real ChatGPT MCP acceptance demonstrates conflict and worktree escape
    behavior;
16. destructive managed-worktree retention cannot race a new ownership acquire,
    and does not hold the transition mutex across deletion;
17. the feature can later be removed in favor of a compatible upstream
    capability without rewriting workspace identity.

Only after this design is accepted should implementation begin.
