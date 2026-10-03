# Runtime Contract

This document defines the DevSpace runtime behavior that callers may rely on
today. It is intentionally narrower than the implementation: implementation
details are not guarantees unless they are stated here.

Changes that intentionally alter this contract should update this document and
the corresponding regression coverage in the same change.

## Tool surfaces

### Guarantees

- Model-facing tool schemas use `snake_case`.
- Both Host coding surfaces include `acquire_write_ownership` and
  `release_write_ownership`.
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

## Host checkout write ownership

- `open_workspace` reports a compact `write_ownership` snapshot: `state`,
  optional `owner_workspace_id`, and `active_mutation_count`. It does not acquire.
- The Host explicitly acquires before `apply_patch`, Claude `write`/`edit`,
  `download_artifact`, or any `exec_command`/`bash` command, and explicitly
  releases after its mutation phase. Shell commands are not classified as read-only.
- Authority is workspace-scoped and keyed by canonical root in the accepted
  stateDir-backed store. Another workspace on that checkout cannot mutate;
  known read-only tools remain usable. Different roots are independent.
- Same-owner acquisition and unowned release are idempotent. Release refuses
  while any active mutation remains. Multiple owner-scoped mutations are allowed;
  completing one removes only its own activity.
- Process-session activity begins before spawn and ends at actual terminal
  cleanup, not at the first result, polling, stdin, or cancellation request.
  Claude bash tracks the actual shell executor for its full synchronous call.
- Ownership errors use the common structured error envelope. They do not count
  toward the patch repeat-failure circuit. Ownership never bypasses workspace,
  path, revision, or patch-recovery checks.
- Restart preserves claims and interrupted activities; there is no automatic
  release, expiry, takeover, waiting, or scheduler. Arbitrary-shell executor
  evidence is non-exhaustive, so crash recovery cannot trust a shell PID alone.
- This Host integration does not enforce ownership in local agents/agentd or
  retention, and adds no operator recovery CLI. Shell execution remains local-user
  authority, not a sandbox or proof that detached descendants have stopped.

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
- Patch publication has a SQLite transaction journal and same-directory
  recovery files. Before `devspace serve` listens, interrupted transactions
  are reconciled: safe partial publications revert to originals; committed
  publications remain in place and only their recovery files are cleaned.
- Once the journal is durably marked `committed`, failure to remove
  transaction-owned cleanup artifacts does not turn the already-published patch
  into a model-visible patch failure. The committed journal remains available
  for startup cleanup retry.
- Ambiguous/external states are never overwritten automatically. Their
  canonical root is blocked from further Codex `apply_patch` until local
  inspection and `devspace recovery resolve <id> --accept-current`; unrelated
  roots and read-oriented tools remain available.
- Managed-worktree cleanup also preserves roots with unresolved patch recovery
  state, so retention pruning cannot remove the filesystem evidence required
  for local recovery.
- After a pruned managed worktree is restored and its session is reactivated,
  the old managed-worktree recovery ref is deleted best-effort. Failure to
  delete that now-redundant ref does not invalidate the successful restore.
- A committed transaction whose project state is already final but whose
  recovery-artifact cleanup cannot be completed may also be explicitly cleared
  with `--accept-current`; this never rewrites project target files.

### Current limitations

- Multi-file publication is not database-style atomic visibility. Another
  process may observe intermediate file states while one patch is committing.
- This is process-crash/service-restart recovery, not power-loss durability:
  no file/directory fsync ordering or distributed multi-process lock is promised.
  Rollback failure or external mutation can still require manual recovery;
  recovery files are retained in that case.
- Crash recovery journals project file state, not provenance for newly created
  parent directories. A crash while preparing a patch whose target requires
  previously missing parent directories can therefore leave an empty directory
  behind. Recovery does not delete such a directory automatically because it
  cannot prove that another local process did not create it after the crash.
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
- Completed process-session snapshots remain replayable in memory for
  30 minutes after terminal completion. This window is intended to tolerate
  ChatGPT connector interruptions and delayed Host follow-up; it is not durable
  storage and does not survive a DevSpace server restart.
- `PROCESS_SESSION_NOT_FOUND` means the session handle is unavailable, not
  that the underlying command necessarily failed or never completed. The Host
  should inspect existing process/log/artifact evidence before deciding whether
  to start a replacement command.
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
  rollback/recovery-required state, path scope, unavailable/invalidated workspaces, and
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
  `apply_patch` and Host write-ownership failures. Other errors and adapters still have legacy or domain-specific
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
- Workspace metadata retention is an explicit local operation. Checkout
  sessions idle for more than 90 days can be inspected or pruned with devspace
  retention. Pruned managed worktree metadata is eligible only when no
  recovery kind or recovery ref exists; recoverable worktree state remains
  protected.
- Retention deletion rechecks lifecycle state atomically in SQLite. A candidate
  reused or reactivated after inspection is skipped rather than deleted, and
  its review refs are not cleaned.
- OAuth client registrations carry a last-used timestamp so future retention
  can distinguish old registrations from clients still being reused. Existing
  clients are backfilled to migration time; no OAuth client is pruned by the
  current workspace retention command.
- OAuth client registrations persist a last-used timestamp for future
  retention decisions. Existing registrations are conservatively backfilled to
  migration time; no OAuth client is deleted by the current retention command.
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
- `open_workspace` returns a bounded `repository_state` when Git state can be
  inspected. It is refreshed on every call and reports branch/HEAD, optional
  upstream ahead/behind counts, dirty-state counters, and a capped changed-path
  sample. The HEAD commit timestamp is included when available. Git inspection
  failure does not prevent workspace entry.
- `authoritative_references` identifies DevSpace-recognized project instruction
  files. Loaded project instructions and discoverable nested instructions are
  represented explicitly instead of relying only on prose priority guidance.
- `open_workspace` may return bounded bootstrap `memory_context`; Memory
  unavailable, malformed, or timed-out bootstrap does not prevent workspace
  entry. The same configured byte budget bounds stable `collaboration_memory`,
  durable `working_memory`, untrusted `pending_memory`, continuation tails, and
  recent-hit metadata together. Construction priority is collaboration memory,
  active working memory, pending memory, continuation history, then hit
  metadata. Pending memory is independently capped at the smaller of 3072 bytes
  or 25% of the configured budget. Raw
  continuation history is independently capped at the smaller of 4096 bytes or
  35% of the configured bootstrap budget, so sparse Working Memory cannot cause
  prior transcript text to consume the whole handoff. Live repository state and
  authoritative project files outrank stored memory when they conflict. The
  complete current-state authority order is live repository or authoritative
  project files, confirmed working/collaboration memory, pending memory,
  continuations, then raw historical evidence.
  Pending proposals are unpromoted and untrusted: they are continuity hints,
  never instructions, and cannot override active or live state.
- `memory_context.policy` is the compact model-facing policy contract for
  these layers. It declares authority order plus machine-readable behavior for
  coverage-gap retrieval, thread expansion, historical-rule confirmation,
  newer conflicting rules, pending memory, and empty Working Memory. The
  `open_workspace` prose instruction should point the host to this policy
  instead of restating the full policy in natural language.
- `memory_context.bootstrap_status` reports only bounded initialization
  metadata for durable Working Memory. In the ChatGPT-first default path,
  DevSpace never calls CHIM's model-bootstrap planner. Active Working Memory
  produces `not_required`; empty Working Memory also produces `not_required`
  with `skip_reason=chatgpt_first_no_model_bootstrap`, zero estimated model
  attempts, and zero selected conversations. Empty Working Memory is not proof
  that the project lacks history.
- `working_memory.confirmation` is a read-only sidecar for project-local
  rule-like memories. `confirmed` may govern future behavior;
  `requires_confirmation` must be presented to the user for confirmation before
  it constrains a current action; `not_applicable` covers memories outside this
  historical-rule gate. For compatibility with an older CHIM that omits this
  sidecar, DevSpace fails closed: invariant/preference/decision memories are
  synthesized as `requires_confirmation`, while other kinds are
  `not_applicable`.
- The policy's retrieval mode is `proactive_on_coverage_gap`: when the current
  request depends on a prior project convention not covered by live
  authoritative state or confirmed memory, the host should use `memory_search`
  proactively. `thread_expansion=search_hits_only` keeps deeper reads bounded.
  `historical_rules=confirmed_only` and
  `unconfirmed_rule=ask_user_before_use` keep raw historical evidence from
  silently becoming a current governing rule.
- The model-facing memory packet reports `byte_budget`, exact final
  `bytes_used`, and per-section byte/count/truncation telemetry, including
  `sections.pending_memory`. Section
  `truncated` means items/messages were omitted by the shared bootstrap budget;
  it does not redefine the separate safety clipping applied inside an individual
  large field or message. Telemetry is itself counted inside the same byte
  budget.
- Pending item conversation IDs, snapshot IDs, and payload provenance never
  authorize `memory_get_thread`. Only continuation and recent/relevant search
  evidence IDs from the bootstrap packet can grant that access.
- `memory_search` performs memory-first project retrieval: bounded durable
  Working Memory is returned before deeper hybrid conversation evidence.
  Working-memory provenance references do not grant thread access.
- Working Memory verification keeps CHIM's `source_state` separate from the
  DevSpace-derived `host_state`. DevSpace may conservatively downgrade only
  operational state/task/blocker memories to `needs_revalidation` when source
  verification metadata is unavailable, the live working tree is dirty, or the
  repository HEAD commit timestamp is newer than the memory's
  `last_verified_at`. Stable, tentative, and expired classifications are not
  promoted or overwritten by this host freshness rule.
- `memory_get_thread` expands only evidence IDs authorized by the current
  project's bootstrap/search discovery. Authorization is bounded,
  process-local, and reset by server restart. The model-facing surface returns
  the latest eight messages by default, caps one request at sixteen messages,
  and uses explicit offsets for older pagination.
- An expansion outside that authorization boundary returns the structured
  `MEMORY_THREAD_NOT_AUTHORIZED` scope error without exposing thread contents.
- Provenance references attached to working-memory items do not automatically
  authorize thread expansion; conversation expansion still requires normal
  bootstrap/search discovery.
- Collaboration-memory provenance follows the same rule: global collaboration
  items do not implicitly authorize their source conversation IDs.
- `devspace memory inspect <project-or-path>` is an operator-only read path.
  It recomputes live repository state, the bounded host handoff packet, and
  CHIM memory health in one diagnostic result. The command may call CHIM's
  internal read-only `memory_health` tool, but that tool is not forwarded to
  the model-facing MCP surface. Inspection does not invoke compilation,
  promotion, or any model.

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
- [Patch crash recovery design](patch-crash-recovery-design.md)
- [File revision design](file-revision-design.md)
- [Tool error contract](tool-error-contract.md)
- [Runtime gap assessment](runtime-gap-assessment.md)
