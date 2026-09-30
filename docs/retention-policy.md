# Persistent metadata retention

DevSpace persists workspace identity so MCP clients can resume work across
server restarts. That state is useful, but it should not grow forever without
an explicit lifecycle.

This policy deliberately starts with the safest class of persistent metadata:
stale checkout workspace sessions.

## Checkout session policy

Local commands:

    devspace retention inspect
    devspace retention inspect --json
    devspace retention prune
    devspace retention prune --json

The default checkout retention window is 90 days since
workspace_sessions.last_used_at.

inspect is read-only. prune is always an explicit local operator action;
DevSpace does not run checkout retention automatically during server startup.

An eligible record must be:

- an active workspace session;
- mode = checkout;
- not a managed worktree;
- idle longer than 90 days;
- still valid under the current allowedRoots;
- not rooted at a location protected by unresolved patch recovery.

Managed worktree sessions, including already-pruned worktrees, are never
considered by this command.

## What pruning removes

Deleting an eligible checkout session removes its SQLite workspace_sessions
row.

Existing foreign keys then cascade to:

- workspace_conversation_bindings for that workspace id;
- loaded_agent_files for that workspace id.

After the database delete succeeds, DevSpace best-effort deletes that
workspace's two Git review refs:

    refs/devspace/review/<workspace-id>/open
    refs/devspace/review/<workspace-id>/baseline

If review-ref cleanup fails, the workspace metadata remains pruned but the
command reports the incomplete cleanup and exits unsuccessfully. Leaving an
orphan review ref is safer than trying to restore a database row after its
dependent records have already been removed.

## User-visible consequence

A model or old conversation that later reuses a pruned workspace_id receives
the normal structured WORKSPACE_NOT_FOUND result and can reopen the project
with open_workspace.

Historical review cards that depend on review history removed by retention may
no longer be reloadable. This is why checkout retention is explicit rather
than an invisible startup task.

The project files themselves are never deleted by checkout retention.

## Protected and deferred state

This command does not prune:

- active or pruned managed worktree sessions;
- refs/devspace/recovery/*;
- unresolved patch transactions or their recovery artifacts;
- local-agent session or turn history;
- OAuth clients or tokens.

Managed worktree sessions can carry the metadata needed to restore an isolated
workspace at its prior base commit or from a preserved recovery ref. Their
lifecycle therefore requires a separate recovery-aware policy.

When a pruned managed worktree is successfully restored and its persisted
session is successfully reactivated, DevSpace now best-effort retires the old
refs/devspace/recovery/<workspace-id> ref. Cleanup happens only after the live
worktree and active session are both established, so a database reactivation
failure cannot strand the recovery data.

If that final ref deletion fails, the restored workspace remains usable and a
warning is logged; the redundant ref is safer to retain than to turn a
successful restore into a failure.

The remaining product question is retention for pruned worktrees that are never
restored. Those rows and recovery refs may represent the only remaining copy of
isolated work, so deleting them requires an explicit recovery-aware discard
policy rather than a background TTL.

## Why there is no retention config knob yet

The first implementation intentionally fixes the conservative checkout window
at 90 days and requires an explicit command. This keeps the initial policy
small and observable while real usage validates the semantics.

If automatic retention or configurable windows are added later, they should be
introduced as a separate product decision with migration, documentation, and
backward-compatibility review rather than silently changing this command.
