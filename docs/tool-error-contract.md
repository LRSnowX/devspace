# Tool error contract

DevSpace distinguishes expected tool-operation failures from MCP protocol
failures. Expected Codex `apply_patch` and process-session failures remain
visible to the model as ordinary tool results with an explicit domain status
and stable machine-readable payload.

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
  expected_revision?,
  current_revision?,
  expected_state?,
  current_state?,
  recovery_files?,
  session_id?,
  repeat_count?,
  previous_error_code?
}
```

`message` remains human-readable diagnostic text. Callers should branch on
`code`, not parse the message.

Successful patch application uses `status: "applied"` and does not include an
`error` payload.

Codex process tools use `status: "running"` or `status: "completed"` for
normal process lifecycle results and `status: "error"` for classified tool
operation failures.

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
  code or signal.

Unexpected programmer defects, transport failures, and other uncategorized
internal exceptions are still thrown rather than falsely classified. They remain
true MCP/connector failures.

## Process exits

A shell command that starts successfully and exits non-zero or by signal is not
a tool protocol error. Process tools continue to report `exit_code`, `signal`,
and other lifecycle fields with `status: "completed"` and no domain error.

## Scope

This phase standardizes `apply_patch` plus Codex process-session misuse and
the domain errors those surfaces consume. Other coding tools may migrate to the
same payload incrementally; they should not be classified by brittle message
matching.
