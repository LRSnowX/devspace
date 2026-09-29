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
- Concurrent `apply_patch` calls for the same workspace root are serialized
  inside one DevSpace process.
- Before destructive publication, touched paths are rechecked against the
  state first observed by that `apply_patch` call.
- If a later publication step fails while DevSpace remains alive, already
  published paths are rolled back in reverse order when their published state
  is still intact.
- A patch may provide per-path `expected_revisions` returned by prior
  `read` calls. A mismatch is rejected before publication, even when the
  patch's hunk context would otherwise still match.
- A patch may provide `expected_absent_paths` for intended-new paths or move
  destinations. If one of those paths already exists when first touched, the
  patch is rejected before publication rather than overwriting it.
- Existing file mode and line-ending behavior are preserved where the current
  implementation supports them.
- Results report affected files and aggregate addition/removal counts.

### Current limitations

- Multi-file publication is not database-style atomic visibility. Another
  process may observe intermediate file states while one patch is committing.
- Transaction rollback is not crash-safe. Process termination, machine failure,
  or rollback failure can leave recovery work. When rollback is blocked by an
  external mutation, DevSpace refuses to overwrite that newer state and reports
  the rollback failure; unused recovery files are retained where possible.
- `expected_revisions` is optional for compatibility. A caller that omits a
  revision does not receive stale-read protection for that earlier read.
- `expected_absent_paths` is also optional for compatibility. Existing
  Add File overwrite behavior remains available unless the caller explicitly
  requires absence.

## File revisions

### Guarantees

- Every successful `read` exposes `revision` in structured output.
- A revision is `sha256:<64 lowercase hex characters>` over the complete raw
  file bytes consumed by that read.
- Pagination does not change revision identity: unchanged pages from one file
  share the same full-file revision.
- Codex `apply_patch` accepts optional per-path
  `expected_revisions: [{ path, revision }]`.
- Codex `apply_patch` accepts optional
  `expected_absent_paths: ["relative/path"]` for paths that must still be
  absent when first touched.
- Every supplied expected-revision path must be touched by the patch.
- Every supplied expected-absence path must be touched by the patch.
- The same path may not require both a content revision and absence.
- Revision validation happens while building the staged logical view, before
  destructive publication.

### Current limitations

- Revisions protect `read -> later apply_patch`; they do not make
  `write`, `edit`, or shell commands revision-aware.
- Revisions represent content identity, not Git commits, mtimes, inode
  identity, or a workspace-wide version.
- Absence is represented as a separate precondition, not as a synthetic
  SHA-256 revision.

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
- Expected Codex `apply_patch` failures return a host-visible domain result
  with `status: "error"` and a stable machine-readable
  `structuredContent.error` payload. Successful application reports
  `status: "applied"`. This avoids current ChatGPT host behavior that converts
  MCP `isError: true` results into string exceptions and discards structured
  content. Current codes cover invalid patches, revision/path-state/concurrent conflicts,
  rollback failure, path scope, unavailable/invalidated workspaces, and
  repeated identical failures.
- Codex `apply_patch` blocks the fourth and later identical request after three
  consecutive known domain failures in the same workspace. Changing the patch
  or expected revisions, succeeding, encountering an unclassified internal
  exception, or restarting the server clears the relevant in-memory streak.
- A process that starts successfully and exits non-zero remains a completed
  process result with its non-zero `exit_code`; it is not reclassified as a
  tool protocol error.

### Current limitation

- The structured coding-tool error taxonomy is currently guaranteed for Codex
  `apply_patch`. Other tools and adapters still have legacy or domain-specific
  error contracts and may migrate incrementally.
- The repeat-failure breaker is process-local and deliberately exact-request
  only. It is not a persistent or semantic loop detector.

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
- [Transactional apply_patch design](apply-patch-transaction-design.md)
- [File revision design](file-revision-design.md)
- [Tool error contract](tool-error-contract.md)
- [Runtime gap assessment](runtime-gap-assessment.md)

