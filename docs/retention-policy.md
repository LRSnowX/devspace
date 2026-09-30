# Persistent metadata retention

DevSpace persists workspace identity so MCP clients can resume work across
server restarts. That state is useful, but it should not grow forever without
an explicit lifecycle.

This policy deliberately handles only workspace metadata whose removal does not
discard recoverable user work: stale checkout sessions and already-pruned
managed worktrees that have no recovery metadata or recovery ref.

## Checkout session policy

Local commands:

    devspace retention inspect
    devspace retention inspect --json
    devspace retention prune
    devspace retention prune --json

The default workspace metadata retention window is 90 days since
workspace_sessions.last_used_at.

inspect is read-only. prune is always an explicit local operator action;
DevSpace does not run workspace metadata retention automatically during server
startup.

An eligible record must be:

- either an active checkout session idle longer than 90 days, or a pruned
  managed worktree session idle longer than 90 days;
- still valid under the current allowedRoots or have a verifiable allowed
  source repository;
- not protected by unresolved patch recovery;
- for a pruned managed worktree, recovery_kind must be empty and
  refs/devspace/recovery/<workspace-id> must not exist.

A pruned managed worktree with recovery metadata, a recovery ref, or recovery
state that cannot be verified is reported as protected/skipped and is not
deleted.

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

Before deleting a candidate, prune rechecks the persisted lifecycle predicates
inside the SQLite DELETE itself. A checkout that was touched again, or a
pruned worktree that was reactivated or gained recovery metadata, is not
deleted. Such candidates are reported as stateChanged, and their review refs
are left untouched. This protects an explicit retention command from racing
with a running DevSpace server.

## User-visible consequence

A model or old conversation that later reuses a pruned workspace_id receives
the normal structured WORKSPACE_NOT_FOUND result and can reopen the project
with open_workspace.

Historical review cards that depend on review history removed by retention may
no longer be reloadable. This is why workspace metadata retention is explicit
rather than an invisible startup task.

Project files themselves are never deleted by workspace metadata retention. A
disposable pruned managed worktree has already had its managed worktree
directory removed by the separate worktree-cleanup lifecycle.

## Protected and deferred state

This command does not prune:

- active managed worktree sessions;
- pruned managed worktree sessions that carry recovery_kind;
- pruned managed worktree sessions with a recovery ref;
- pruned managed worktree sessions whose recovery state cannot be verified;
- refs/devspace/recovery/*;
- unresolved patch transactions or their recovery artifacts;
- local-agent session or turn history;
- OAuth clients or tokens.

## Local-agent history is user-owned durable state

Local-agent records are not cache entries. A logical agent id can be continued
after the daemon restarts, and its persisted providerSessionId is the bridge
back to the provider conversation when that provider supports resume.

For that reason, idle, stopped, or error local-agent sessions are not candidates
for age-based workspace retention. An old error record may still be a useful
continuation point, and deleting it would also cascade its durable turn history.

DevSpace currently has no agents delete/archive command. If local-agent history
eventually needs lifecycle controls, they should be explicit user-owned
operations that account for both the local logical record and provider session
release semantics. A background TTL is not an acceptable substitute.

## OAuth client usage signal

OAuth dynamic client registrations can also accumulate across reconnects and
Refresh cycles, but an unreferenced client is not automatically disposable: a
host may persist that client id and reuse it for a later authorization flow.

DevSpace therefore records a separate oauth_clients.last_used_at signal before
introducing any client-retention policy. The timestamp is updated when a client
is registered, looked up by the OAuth provider, or successfully receives a new
token pair.

Existing clients are backfilled to the migration time rather than their
historical issued_at value. This intentionally gives every pre-existing client
a fresh observation window and prevents old registrations from becoming
immediate retention candidates merely because the signal did not exist before.

No OAuth client is deleted by devspace retention today. Expired access and
refresh tokens continue to be removed by the OAuth store's existing expiry
cleanup. A future client-retention slice should require all of the following:

- no unexpired access token;
- no unexpired refresh token;
- a sufficiently old last_used_at value;
- an explicit local retention action rather than invisible startup deletion.

Recoverable managed worktree sessions can carry the metadata needed to restore
an isolated workspace from a preserved recovery ref. Those sessions remain
outside destructive retention. Only already-pruned sessions proven to have no
recovery metadata/ref are treated as disposable metadata; reopening the project
can create a fresh equivalent worktree.

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
