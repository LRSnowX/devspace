# Runtime Contract

This document defines the DevSpace runtime behavior that callers may rely on
today. It is intentionally narrower than the implementation: implementation
details are not guarantees unless they are stated here.

Changes that intentionally alter this contract should update this document and
the corresponding regression coverage in the same change.

## Tool surfaces

### Guarantees

- Model-facing tool schemas use `snake_case`.
- The core Codex surface is:
  - `open_workspace`
  - `read`
  - `apply_patch`
  - `exec_command`
  - `write_stdin`
  - `show_changes`
- The core Claude surface is:
  - `open_workspace`
  - `read`
  - `write`
  - `edit`
  - `bash`
  - `show_changes`
- Optional capabilities may add tools without changing the core coding
  surfaces. In particular, configured read-only Memory adds
  `memory_search` and `memory_get_thread`.

### Not a guarantee

- DevSpace does not guarantee one fixed tool count across configurations.
- Internal project-resolution, registry-administration, and Memory backend
  operations are not model-facing tools.

## Workspace and filesystem

### Guarantees

- `open_workspace` returns an opaque `workspace_id` that subsequent
  workspace-scoped calls reuse.
- Checkout mode operates on the selected checkout. Worktree mode creates and
  tracks an isolated managed Git worktree.
- Workspace roots must remain inside configured allowed roots. Managed
  worktrees must remain inside the configured worktree root.
- File operations and command working directories reject traversal and
  symlink escapes outside the workspace boundary.
- Equivalent checkout paths and filesystem aliases resolve to the same
  canonical checkout identity where the workspace lifecycle requires it.
- Project names and registered aliases are conveniences for entering a
  workspace; the resulting workspace still uses the same path and allowed-root
  validation.

### Current limitation

- Shell commands run with the local user's authority. Workspace path checks do
  not turn shell execution into a filesystem or process sandbox.

## `apply_patch`

### Guarantees

- Patch paths are relative to the workspace and may not escape it through
  traversal or symlinks.
- Patches operate on UTF-8 text files. Binary or invalid UTF-8 inputs are
  rejected.
- One patch may add, overwrite, update, delete, or move files.
- Patch actions are evaluated against a staged logical view, so later actions
  in the same patch can operate on results produced by earlier actions.
- Hunk/context failures are detected before staged changes are published.
- Existing file mode and line-ending behavior are preserved where the current
  implementation supports them.
- Results report affected files and aggregate addition/removal counts.

### Current limitations

- Publication is not a multi-file filesystem transaction. If a later
  publication or deletion fails after an earlier file has already been
  published, DevSpace does not currently guarantee automatic rollback of the
  earlier file.
- There is no read-version, expected-revision, or equivalent stale-read
  contract. A patch proves that its context matches when the patch is applied;
  it does not prove that the file is unchanged since an earlier model read.

## Process lifecycle

### Guarantees

- Codex `exec_command` returns the completed result when a process exits
  within the yield window; otherwise it returns a `session_id` for continued
  interaction.
- Model-facing yield windows are bounded to 12 seconds.
- `write_stdin` can poll a running process, send input, send Ctrl-C, and
  resize supported PTY sessions.
- Codex process results expose the current lifecycle fields, including
  `running`, `exit_code`, `signal`, `wall_time_ms`, and
  `output_truncated` when applicable.
- A non-zero process exit is still a completed tool call, but is logged as an
  unsuccessful command outcome.

### Not a guarantee

- DevSpace does not hide arbitrary workflows inside an autonomous process
  loop. The host remains responsible for deciding what to run next.

## Results and errors

### Guarantees

- Tools that declare structured output keep a model-readable `result` where
  the current surface defines one.
- Tool calls preserve their real success/failure boundary in logging.
- Errors are returned or thrown at the layer that detects them rather than
  being silently converted into successful results.

### Current limitation

- DevSpace does not yet expose one uniform structured error taxonomy across all
  tools and adapters.

## Review

### Guarantees

- `show_changes` presents aggregate workspace changes relative to the stored
  review checkpoint and advances the current review checkpoint when reviewing
  current changes.
- Historical `review_ref` values can reopen prior reviews without advancing
  the current checkpoint.
- Review checkpoints survive manager/server recreation through persisted state.
- Unborn Git repositories are reviewable without creating a synthetic initial
  commit.
- Review state is scoped to its workspace/root and may not be reused for a
  different root.
- Rich UI metadata is supplemental; the model-readable result remains usable
  without the UI.

## MCP and OAuth

### Guarantees

- The HTTP MCP endpoint supports the current modern MCP path and the tested
  stateless compatibility path for supported older clients.
- Request metadata required by workspace/session behavior is preserved through
  the modern MCP adapter.
- Unauthenticated MCP requests are rejected.
- Bearer-resource validation accepts only the canonical MCP resource and exact
  configured aliases; child paths, query variants, and unrelated resources are
  not accepted as equivalents.

### Not a guarantee

- Compatibility is limited to behavior covered by current supported protocol
  handling; DevSpace does not promise compatibility with arbitrary historical
  MCP variants.

## Optional Memory extension

When Memory is configured:

### Guarantees

- Memory remains a read-only optional extension to the coding surface.
- `open_workspace` may return bounded bootstrap `memory_context`; Memory
  unavailable, malformed, or timed-out bootstrap does not prevent workspace
  entry.
- `memory_search` performs project-relevant retrieval.
- `memory_get_thread` expands only evidence IDs authorized by the current
  project's bootstrap/search discovery. Authorization is bounded,
  process-local, and reset by server restart.

### Current limitation

- The CHIM project filter is a relevance heuristic, not a security-grade
  project-membership boundary. DevSpace's thread-expansion authorization
  prevents arbitrary ID expansion but does not redefine CHIM's relevance
  semantics.

## Related documentation

- [Security model](security.md)
- [Configuration reference](configuration.md)
- [ChatGPT coding workflow](chatgpt-coding-workflow.md)
- [Development and manual QA](development.md)

