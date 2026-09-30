# Tool error contract

DevSpace distinguishes expected tool-operation failures from MCP protocol
failures. Expected Codex `apply_patch` failures remain visible to the model as
ordinary tool results with an explicit domain status and stable machine-readable
payload.

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
  repeat_count?,
  previous_error_code?
}
```

`message` remains human-readable diagnostic text. Callers should branch on
`code`, not parse the message.

Successful patch application uses `status: "applied"` and does not include an
`error` payload.

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

For these expected `apply_patch` failures:

- the tool result has `status: "error"`;
- text content preserves the human-readable message;
- `structuredContent.error` contains the payload above;
- success-shaped counters are neutral (`additions: 0`, `removals: 0`,
  `files: []`) so the declared output schema remains stable.

Unexpected programmer defects, transport failures, and other uncategorized
internal exceptions are still thrown rather than falsely classified. They remain
true MCP/connector failures.

## Process exits

A shell command that starts successfully and exits non-zero is not a tool
protocol error. Process tools continue to report `exit_code`, `signal`, and
other lifecycle fields as a completed command result.

## Scope

This phase standardizes `apply_patch` and the domain errors it consumes.
Other coding tools may migrate to the same payload incrementally; they should
not be classified by brittle message matching.
