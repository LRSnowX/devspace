# Tool error contract

DevSpace distinguishes expected tool-operation failures from MCP protocol
failures. Expected `open_workspace`, Memory authorization/workspace,
`read`, Claude mutation-path, Codex `apply_patch`, and process-session
failures remain visible to the model as ordinary tool results with an explicit
domain status and stable machine-readable payload.

This is intentional host-compatibility behavior. The current ChatGPT MCP host
converts `isError: true` tool results into connector exceptions and drops
`structuredContent`. DevSpace therefore keeps expected patch failures inside a
domain-result envelope instead of relying on the MCP transport error flag.

## Payload

Structured tool errors use:

```text
status: "error"
error: {
  code,
  category,
  message,
  retryable,
  path?,
  candidate_paths?,
  expected_revision?,
  current_revision?,
  expected_state?,
  current_state?,
  recovery_files?,
  conversation_id?,
  session_id?,
  repeat_count?,
  previous_error_code?,
  owner_workspace_id?,
  active_mutation_count?
}
```

`message` remains human-readable diagnostic text. Callers should branch on
`code`, not parse the message.

Successful patch application uses `status: "applied"` and does not include an
`error` payload.

Codex process tools use `status: "running"` or `status: "completed"` for
normal process lifecycle results and `status: "error"` for classified tool
operation failures.

Successful reads use `status: "read"`, return the complete-file revision, and
do not include an `error` payload.

Successful Claude `write` and `edit` mutations use `status: "applied"`.

Successful `open_workspace` calls use `status: "opened"`.

Ownership acquire uses `acquired`/`already_owned`; release uses
`released`/`not_owned`. Both return a compact `write_ownership` snapshot.
Successful Claude `bash` uses `status: "completed"`; ordinary upstream shell
failures keep their existing error behavior.

## Host ownership codes

Ownership tools and direct Host mutations use the same ordinary structured
error envelope, without `isError: true`:

- `WRITE_OWNERSHIP_REQUIRED`: category `state`, retryable `true`.
- `WRITE_OWNERSHIP_CONFLICT`: category `conflict`, retryable `true`; includes
  `owner_workspace_id` when the store has a decoded owner.
- `WRITE_OWNERSHIP_BUSY`: category `conflict`, retryable `true`; includes
  `active_mutation_count` when available.
- `WRITE_OWNERSHIP_RECOVERY_REQUIRED`: category `recovery`, retryable `false`.

Internal claim/activity nonces, executor PIDs, and persistence filenames are
not model-facing fields. Ownership failures do not advance the patch
repeat-failure circuit; acquiring ownership does not clear patch-recovery state.

Memory success results remain the read-only CHIM payload unchanged. Classified
local Memory failures use the common `status: "error"` envelope.

## open_workspace project-entry codes

`open_workspace` exposes:

- `PROJECT_NOT_FOUND`
  - category: `not_found`
  - retryable: false for the unchanged entry
  - a relative project name or alias cannot be resolved to a registered project
    or unique top-level directory in an allowed root.
  - includes `path` with the requested project entry.
- `PROJECT_AMBIGUOUS`
  - category: `invalid_request`
  - retryable: false for the unchanged entry
  - a relative project name resolves to more than one allowed-root candidate.
  - includes `path` and sorted `candidate_paths`; callers should select an
    absolute path or register an unambiguous project alias.
- `PROJECT_NOT_DIRECTORY`
  - category: `invalid_request`
  - retryable: false
  - the resolved checkout target exists but is not a directory.
  - includes `path`.
- `PATH_SCOPE_VIOLATION`
  - category: `scope`
  - retryable: false
  - an absolute, home-relative, discovered, or canonicalized project target
    escapes the configured allowed roots.

The current MCP Apps registration path is most reliable with a single object
output schema, so `open_workspace` advertises one envelope with `status` and
optional success/error fields rather than a Zod union. Runtime tests enforce
that `status: "opened"` returns the complete workspace fields, while
`status: "error"` returns the structured error payload without inventing a
workspace id or root.

Git/worktree-specific failures such as a non-Git source or invalid base ref are
not classified in this phase. They remain transport errors until those
dependency-owned semantics have a stable typed signal.

## Memory codes

`memory_search` and `memory_get_thread` reuse typed workspace lifecycle
errors such as `WORKSPACE_NOT_FOUND` and `WORKSPACE_INVALIDATED`.

`memory_get_thread` additionally exposes:

- `MEMORY_THREAD_NOT_AUTHORIZED`
  - category: `scope`
  - retryable: true after discovery
  - the requested conversation/evidence ID was not authorized for the current
    project by this process's bounded bootstrap/search discovery.
  - includes `conversation_id`.
  - callers should run `memory_search` for the current project (or reopen the
    workspace when bootstrap discovery is appropriate) and retry only with an
    ID actually returned by discovery.

This error does not change CHIM's relevance semantics. DevSpace still treats
project relevance as a heuristic and enforces only the existing bounded,
process-local expansion authorization boundary. CHIM transport/tool failures
remain unclassified and are still surfaced as MCP failures.

## read codes

The common `read` tool exposes:

- `FILE_NOT_FOUND`
  - category: `not_found`
  - retryable: false for the unchanged request
  - the requested path does not resolve to a readable file because the file or
    an intermediate path component is missing.
  - includes `path`.
- `PATH_SCOPE_VIOLATION`
  - category: `scope`
  - retryable: false
  - the requested path escapes or resolves outside the permitted workspace or
    advertised skill scope.
- `WORKSPACE_NOT_FOUND`
  - category: `not_found`
  - retryable: true
  - the supplied workspace id is no longer available; reopen the workspace.
- `WORKSPACE_INVALIDATED`
  - category: `state`
  - retryable: true
  - the previously opened workspace root disappeared or changed identity;
    reopen it before reading again.

`read` only classifies failures that already have a typed DevSpace error or a
stable filesystem errno. Upstream read semantics such as an out-of-range
`offset` remain transport errors until they have a non-brittle typed contract;
DevSpace does not classify them by parsing human-readable messages.

## Claude mutation path codes

Claude `write` and `edit` reuse the common typed workspace/path errors:

- `PATH_SCOPE_VIOLATION`
  - category: `scope`
  - retryable: false
  - the requested mutation path escapes or resolves outside the workspace.
- `WORKSPACE_NOT_FOUND`
  - category: `not_found`
  - retryable: true
  - the supplied workspace id is no longer available; reopen the workspace.
- `WORKSPACE_INVALIDATED`
  - category: `state`
  - retryable: true
  - the previously opened workspace root disappeared or changed identity;
    reopen it before mutating files.

`edit` also exposes `FILE_NOT_FOUND` when its target disappears or does not
exist, using filesystem `ENOENT`/`ENOTDIR` rather than message parsing.

Upstream edit semantics such as zero matches, multiple matches, and overlapping
replacements are still plain upstream errors. They remain transport errors
until the upstream surface provides a stable typed signal; DevSpace does not
infer those cases from human-readable messages.

## apply_patch codes

The Codex `apply_patch` tool currently exposes:

- `PATCH_INVALID`
  - category: `invalid_request`
  - retryable: false
  - malformed patch syntax, invalid patch context, binary/invalid UTF-8 input,
    invalid expected-revision declarations, and similar request defects.
- `REVISION_CONFLICT`
  - category: `conflict`
  - retryable: true
  - an `expected_revisions` value no longer matches the file.
  - may include `path`, `expected_revision`, and `current_revision`.
- `PATH_STATE_CONFLICT`
  - category: `conflict`
  - retryable: true
  - a path state precondition no longer holds, currently used when an
    `expected_absent_paths` entry exists.
  - may include `path`, `expected_state`, and `current_state`.
- `CONCURRENT_MODIFICATION`
  - category: `conflict`
  - retryable: true
  - a touched path changed after the patch call began but before publication or
    safe rollback.
- `ROLLBACK_FAILED`
  - category: `recovery`
  - retryable: false
  - publication failed and complete automatic recovery could not be confirmed.
  - may include `recovery_files` retained for manual recovery.
- `PATCH_RECOVERY_REQUIRED`
  - category: `recovery`
  - retryable: false
  - an unresolved interrupted patch transaction blocks further Codex patches
    for this canonical workspace root until local recovery inspection and
    explicit operator resolution. Other roots remain usable.
- `PATH_SCOPE_VIOLATION`
  - category: `scope`
  - retryable: false
  - a patch path escapes or resolves outside the permitted workspace scope.
- `WORKSPACE_NOT_FOUND`
  - category: `not_found`
  - retryable: true
  - the supplied workspace id is no longer available; reopen the workspace.
- `WORKSPACE_INVALIDATED`
  - category: `state`
  - retryable: true
  - the previously opened workspace root disappeared or changed identity;
    reopen it before continuing.
- `REPEATED_FAILURE`
  - category: `state`
  - retryable: false for the identical request
  - returned before execution when the exact same `apply_patch` request has
    already produced three consecutive known domain failures in that workspace.
  - includes `repeat_count` and `previous_error_code`.

## Process-session codes

The Codex `write_stdin` surface also exposes:

- `PROCESS_SESSION_NOT_FOUND`
  - category: `not_found`
  - retryable: true
  - the requested session no longer exists, including after its completed
    result has already been consumed; start a new command.
  - includes `session_id`.
- `PROCESS_SESSION_SCOPE_MISMATCH`
  - category: `scope`
  - retryable: false
  - the session belongs to a different workspace and cannot be accessed through
    the supplied workspace id.
  - includes `session_id`.
- `PROCESS_SESSION_NOT_INTERACTIVE`
  - category: `state`
  - retryable: false
  - a PTY-only operation, currently terminal resize, was requested for a
    non-PTY process.
  - includes `session_id`.

Process tools also reuse existing workspace/path errors, such as
`WORKSPACE_NOT_FOUND`, when the failure is already represented by the common
tool-error taxonomy.

## Repeat-failure circuit breaker

The Codex `apply_patch` surface has a deliberately narrow process-local
circuit breaker:

- identity is the workspace id plus the exact patch text plus the sets of
  `expected_revisions` and `expected_absent_paths`;
- expected-revision ordering is normalized, so reordering the same expectations
  does not bypass the breaker;
- expected-absence ordering is normalized for the same reason;
- the first three identical known domain failures are returned normally;
- the fourth identical attempt and later identical attempts are blocked before
  the patch engine runs and return `REPEATED_FAILURE`;
- changing the patch or either precondition set clears the streak immediately;
- a successful patch clears the streak;
- an unexpected/unclassified internal exception clears the streak and is still
  thrown normally;
- state is in memory only and is reset when the DevSpace server restarts;
- state is bounded to a finite number of workspace entries.

The breaker intentionally does **not** group failures merely because they touch
the same path or share an error code. Legitimate modified retries must remain
available.

## MCP behavior

For expected classified failures:

- the tool result has `status: "error"`;
- text content preserves the human-readable message;
- `structuredContent.error` contains the payload above;
- tool-specific success fields remain neutral so the declared output schema
  stays stable. Patch failures use zero diff counters and an empty file list;
  process failures report `running: false`, `wall_time_ms: 0`, and no exit
  code or signal; read failures omit `revision`; Claude mutation path failures
  omit success-specific mutation details; `open_workspace` failures omit
  workspace identity and review fields; Memory authorization failures preserve
  the requested `conversation_id` but do not expose thread contents.

Unexpected programmer defects, transport failures, and other uncategorized
internal exceptions are still thrown rather than falsely classified. They remain
true MCP/connector failures.

## Process exits

A shell command that starts successfully and exits non-zero or by signal is not
a tool protocol error. Process tools continue to report `exit_code`, `signal`,
and other lifecycle fields with `status: "completed"` and no domain error.

## Scope

This phase standardizes `open_workspace` project-entry failures, local Memory
authorization/workspace failures, `read`, Claude mutation path failures,
`apply_patch`, plus Codex process-session misuse and the domain errors those
surfaces consume. Dependency-owned tool semantics should not be classified by
brittle message matching.
