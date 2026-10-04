# Configuration Reference

DevSpace stores durable settings in `~/.devspace/config.jsonc`. The file accepts
comments and trailing commas and is validated before the server starts. Editor
completion is provided by the versioned [JSON Schema](../schema/v1/devspace.schema.json),
also hosted at the URL in the file's `$schema` property.

Authentication stays separate because it contains a secret:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

Run `devspace init` to create both files. `devspace config set publicBaseUrl
<url|null>` updates the JSONC document without discarding its comments.

## Complete example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Waishnav/devspace/main/schema/v1/devspace.schema.json",
  "configVersion": 1,

  "server": {
    "host": "127.0.0.1",
    "port": 7676,
    // Use the public origin only; do not append /mcp.
    "publicBaseUrl": "https://devspace.example.com",
    "allowedHosts": [],
    "trustProxy": false,
  },
  "workspaces": {
    "allowedRoots": ["~/personal", "~/work"],
    "worktreeRoot": "~/.devspace/worktrees",
    "conversationAuthorization": false,
  },
  "storage": {
    "stateDir": "~/.local/share/devspace",
  },
  "tools": {
    "mode": "codex",
  },
  "memory": {
    "enabled": false,
    "command": null,
    "dataHome": null,
    "bootstrapTimeoutMs": 5000,
    "bootstrapByteBudget": 12288,
  },
  "ui": {
    "enabled": true,
  },
  "artifacts": {
    "enabled": false,
    "maxFileBytes": 104857600,
  },
  "skills": {
    "enabled": true,
    "paths": [],
    "agentDir": "~/.codex",
  },
  "subagents": {
    "enabled": false,
    "instructions": "on-demand",
    "providers": [],
  },
  "logging": {
    "level": "info",
    "format": "json",
    "requests": true,
    "assets": false,
    "toolCalls": true,
    "shellCommands": false,
  },
  "oauth": {
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 2592000,
    "scopes": ["devspace"],
    "allowedResourceUrls": [],
    "allowedRedirectHosts": ["chatgpt.com", "localhost", "127.0.0.1"],
  },
}
```

Omitted sections and keys use the defaults shown above. An empty
`workspaces.allowedRoots` uses the current working directory. Unknown keys are
rejected so spelling mistakes cannot silently alter behavior.

## Conversation workspace authorization (opt-in)

Set `workspaces.conversationAuthorization: true` and keep `ui.enabled: true`
for the ChatGPT MCP App approval flow. With usable Host-provided
`_meta["openai/session"]`, `open_workspace` requests `inspect` by default;
use `access: "modify"` for mutation work. Worktree creation always requires
modify. The user approves Inspect, Modify, or Deny in the App, then the Host
retries `open_workspace`. An inspect-only request cannot be escalated by the
approval call; request modify with a new card. With UI disabled, scoped requests
remain blocked; there is no model-callable approval fallback.

Each conversation can authorize multiple canonical checkout targets. Managed
worktrees inherit their source Git checkout's target, including when opened from
a source subdirectory. Approvals and pending requests are process-local;
restart removes them. Requests expire after two minutes and are single-use and
conversation-bound. Inspect permits annotated read-only tools; modify permits
mutation-capable and unclassified workspace tools, but does not acquire Write
Ownership or authorize subagents.

Disabled behavior, and hosts without usable `openai/session`, retain the existing
upstream-compatible behavior. This is a trusted-Host conversation boundary, not
OAuth identity, a replacement for `allowedRoots`, or a shell sandbox. The Host
must enforce MCP Apps app-only visibility and propagate the same conversation
metadata on App calls. Real connector acceptance remains a separate check.

## Project Registry and Memory Adapter

Project registrations live in `~/.devspace/projects.json` beside the versioned
configuration. Manage them locally with `devspace projects list` and
`devspace projects register <name> <path> [--alias <alias>]...`; restart the
server after changing registrations. `open_workspace` accepts an absolute or
`~/` path, a registered canonical name or alias, or a unique top-level directory
name under an allowed root. The registry does not add MCP management tools and
does not relax allowed-root or canonical-path checks.

Memory is opt-in through the `memory` section of the versioned config. Set
`enabled: true` and `command` to the independent CHIM MCP executable; optional
`dataHome` selects its data directory. DevSpace calls only CHIM read tools.
`open_workspace` returns at most `bootstrapByteBudget` bytes of compact
`memory_context` after a `bootstrapTimeoutMs` (default 5000 ms) attempt;
unavailable, timed-out, or malformed Memory responses do not block workspace
entry. The default budget is 12288 bytes. The bootstrap may include bounded
`collaboration_memory`, bounded `working_memory`, bounded `pending_memory`, and
bounded `continuations` from recent project conversations so a new host
conversation receives stable cross-project collaboration rules, durable current
project state, unpromoted continuity proposals, and recent episodic context
without an explicit history lookup; full threads are never injected
automatically. DevSpace requests up to eight pending proposals. There is no
DevSpace configuration knob for this limit. Pending memory has its own cap of
the smaller of 3072 bytes or 25% of the bootstrap budget. Collaboration memory
is constructed first, then current working memory, pending memory, continuations,
recent/relevant metadata, and non-current working memory. Source verification
and live Host freshness both affect budgeting before allocation. Non-current
items remain eligible continuity evidence, with truthful sidecars and marked
160-character value previews for large values; they are evicted before fresher
continuation evidence under final byte pressure. This changes budget priority,
not rule confirmation or the authority policy. All Working Memory still shares
its existing section cap and the unchanged total budget.
Raw continuation history has an
additional cap of the smaller of 4096 bytes or 35% of the configured bootstrap
budget; unused Working Memory space is therefore not automatically filled with
old transcript text. Live repository state and authoritative project files
remain stronger evidence than stored memory when they conflict. The authority
order is live repository or authoritative project files, confirmed
working/collaboration memory, pending memory, continuations, then raw historical
evidence. Pending entries are untrusted, unpromoted
proposals that may be used only as continuity hints; they are not instructions
and cannot override active or live state.
The same policy is exposed in compact machine-readable form as
`memory_context.policy`; the model-facing `open_workspace` instruction points
to that policy instead of restating the full memory workflow in prose.
In the ChatGPT-first default workflow, empty Working Memory does not trigger
CHIM's model-bootstrap planner. DevSpace returns a compact `bootstrap_status`
with `state=not_required`, `skip_reason=chatgpt_first_no_model_bootstrap`, and
zero model-attempt/selected-conversation counts. Active Working Memory also
returns `not_required`, with `skip_reason=active_working_memory_exists`.

Project-local rule-like Working Memory also exposes a confirmation sidecar.
Only `confirmed` invariant/preference/decision memory should govern future
behavior. `requires_confirmation` must be reconfirmed with the user before it
constrains a current action, and `not_applicable` denotes memory outside that
rule gate. If CHIM is old enough to omit confirmation metadata, DevSpace treats
rule-like memory as `requires_confirmation` rather than assuming it is trusted.
`memory_context.policy.retrieval=proactive_on_coverage_gap` tells the host to
query CHIM when a request relies on prior project-specific policy not covered
by live state or confirmed memory. The policy also carries the bounded-thread,
confirmed-only historical-rule, reconfirm-on-conflict, pending-memory, and
empty-working-memory semantics.
`memory_context` also reports read-only budget telemetry. `bytes_used` is the
exact UTF-8 JSON size of the final model-facing memory packet, including the
telemetry itself. `sections` reports the retained byte/count footprint and
budget-level truncation state for collaboration memory, project working memory,
pending memory, continuations, and recent/relevant hits. Pending telemetry keeps
CHIM's `revalidation_excluded_count` separate from proposals dropped by local
byte limits. These metrics do not add memory
authority and do not include DevSpace-internal pre-budget bookkeeping.
`open_workspace` exposes that stronger evidence explicitly as a bounded
`repository_state` snapshot plus `authoritative_references`. The repository
snapshot includes branch/HEAD/upstream divergence, dirty-state counts, and at
most twenty changed-path samples. It also includes the HEAD commit timestamp
when available. It is refreshed on every open, including a reused checkout
workspace; Memory bootstrap remains lifecycle-bounded.
Project Working Memory carries a verification sidecar. CHIM's `source_state`
is preserved, while DevSpace derives a separate `host_state` from that source
state plus live repository freshness. Operational state/task/blocker memories
are downgraded to `needs_revalidation` when CHIM verification metadata is
unavailable, when the working tree is dirty, or when repository HEAD is newer
than the memory's `last_verified_at`. Stable decisions/preferences/invariants,
tentative memories, and expired memories are not overwritten by this host-side
operational freshness rule.
When enabled, the only model-facing Memory tools are `memory_search` and
`memory_get_thread`. The latter accepts only conversation/evidence IDs previously
discovered for the current workspace project in this server process, returns a
small latest-message page by default, and requires explicit pagination for older
history. This
bounded authorization expires on restart; attempts to expand another ID return
`MEMORY_THREAD_NOT_AUTHORIZED` and should be retried only after project-scoped
discovery returns that ID. CHIM project search is a relevance filter, not a
strict project-membership security boundary.

For local operator diagnostics, `devspace memory inspect <project-or-path>`
combines the same model-facing handoff mapping with a freshly read repository
snapshot and CHIM's read-only `memory_health` report. `--json` returns the
full structured diagnostic; the default output is a compact summary. This
operator command does not add `memory_health` to the model-facing tool
allow-list and does not invoke the memory compiler or another model. Unique
project names may be discovered recursively within a bounded depth under
allowed roots; ambiguous names must be disambiguated with an absolute path or a
canonical project registration.

`oauth.allowedResourceUrls` accepts exact alternate MCP resource URLs for
clients that connect through a resource alias, such as a secure MCP tunnel.
The normal `server.publicBaseUrl` `/mcp` resource remains allowed automatically.
Configure the complete alias URL, not a hostname or origin; aliases do not
change OAuth discovery URLs or proxy routing.
Resource URLs must use HTTPS; HTTP is allowed only for `localhost`, `127.0.0.1`,
or `[::1]`, with optional ports. Restart DevSpace after changing
`oauth.allowedResourceUrls`: the provider reads this policy at server creation.
After restarting, refresh tokens for removed aliases can no longer mint tokens.

## Tool modes and UI

`tools.mode` accepts two values:

| Value    | Tool surface                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `codex`  | Default. `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, and `show_changes`. |
| `claude` | `open_workspace`, `read`, `write`, `edit`, `bash`, and `show_changes`.                               |

The dedicated MCP tools `grep`, `glob`, and `ls` are not exposed. Each mode uses
its shell tool with programs such as `rg`, `find`, and `ls` when it needs those
operations.

DevSpace attaches Apps UI metadata only to `open_workspace` and `show_changes`.
This avoids rendering an iframe for every read, edit, search, or command call.
Setting `ui.enabled` to `false` removes the metadata but does not remove the
`show_changes` tool.

## Skills and subagents

DevSpace discovers standard Agent Skills from `~/.agents/skills`, project
`.agents/skills`, and `~/.devspace/skills`. It also checks
`skills.agentDir/skills` and each path in `skills.paths`. Relative custom paths
are resolved from the active workspace.

When Subagents are enabled for MCP workspaces, DevSpace keeps its bundled
`subagents` skill synchronized at `~/.devspace/skills/subagents/SKILL.md`.
That managed copy is the authoritative `subagents` skill for DevSpace and is
refreshed when the packaged skill changes.

Subagent providers are explicit. Omitted providers are disabled:

```jsonc
{
  "configVersion": 1,
  "subagents": {
    "enabled": true,
    "instructions": "on-demand",
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.4",
        "effort": "high",
        "command": "/opt/devspace/bin/codex-wrapper",
        "env": {
          "CODEX_HOME": "/home/alice/.codex-work",
          "OPENAI_BASE_URL": "https://api.example.com/v1",
        },
      },
      {
        "id": "claude",
        "enabled": true,
        "model": "sonnet",
      },
    ],
  },
}
```

`subagents.instructions` controls when ChatGPT receives the managed workflow:

| Value       | Behavior                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `on-demand` | Default. `open_workspace` advertises the `subagents` skill and the model reads it only when the task benefits from delegation.                  |
| `preload`   | `open_workspace` includes the `subagents` workflow in its initial workspace instructions instead of advertising that skill for a separate read. |

Both modes only make the workflow available; neither tells the model to prefer
subagents for routine work.

Profiles are loaded from `~/.devspace/agents/*.md` and project
`.devspace/agents/*.md`. `devspace agents targets` prints the configured targets
available in the current workspace.

`command` names one executable. DevSpace does not split shell arguments, so use
a wrapper executable when startup needs fixed arguments. `env` maps environment
variable names to literal string values and preserves empty strings. DevSpace
does not expand `$NAME` references in these values.

All subagent providers accept `env`. The daemon inherits its startup
environment, then overlays the provider's `env` without mutating the daemon's
process environment. OpenCode receives that environment on its managed server
process; embedded Pi scopes it to its provider requests and command execution.

Codex, Claude, Cursor, Copilot, and Grok also accept `command`. OpenCode and Pi
do not expose a command override. For providers that support it, an explicit
`command` wins over both the inherited command override and a command override
placed in `env`.

Existing process-level overrides remain supported: `CODEX_COMMAND`,
`CODEX_HOME`, `CLAUDE_COMMAND`, `CURSOR_COMMAND`, `COPILOT_COMMAND`,
`GROK_COMMAND`, and `GROK_AGENT_PROFILE`. Provider configuration takes
precedence where the same value is set in both places.

DevSpace writes `config.jsonc` with mode `0600`, but provider environment values
are still plain text on disk. Keep the file out of version control. Leave
credentials in the process environment if you do not want DevSpace to persist
them.

## Native artifact download

Set `artifacts.enabled` to `true` when a host needs to save a native attached or
generated file into an open workspace. `artifacts.maxFileBytes` limits one
streamed file. The secure publication path is available on Linux, macOS, and
Windows; the tool is not registered on BSD.

## Environment boundary

Only two user-facing DevSpace environment variables remain:

| Variable                     | Purpose                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `DEVSPACE_CONFIG_DIR`        | Bootstrap location for `config.jsonc`, `auth.json`, skills, and profiles. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Optional secret override for the owner token stored in `auth.json`.       |

Durable environment settings were removed in v1.1. Move existing deployment
values to these JSONC keys:

| Removed setting                                | JSONC key                      |
| ---------------------------------------------- | ------------------------------ |
| `HOST`, `PORT`                                 | `server.host`, `server.port`   |
| `DEVSPACE_PUBLIC_BASE_URL`                     | `server.publicBaseUrl`         |
| `DEVSPACE_ALLOWED_HOSTS`                       | `server.allowedHosts`          |
| `DEVSPACE_TRUST_PROXY`                         | `server.trustProxy`            |
| `DEVSPACE_ALLOWED_ROOTS`                       | `workspaces.allowedRoots`      |
| `DEVSPACE_WORKTREE_ROOT`                       | `workspaces.worktreeRoot`      |
| `DEVSPACE_STATE_DIR`                           | `storage.stateDir`             |
| `DEVSPACE_TOOL_MODE`, `DEVSPACE_MINIMAL_TOOLS` | `tools.mode`                   |
| `DEVSPACE_WIDGETS`                             | `ui.enabled`                   |
| `DEVSPACE_ARTIFACTS`                           | `artifacts.enabled`            |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES`             | `artifacts.maxFileBytes`       |
| `DEVSPACE_SKILLS`                              | `skills.enabled`               |
| `DEVSPACE_SKILL_PATHS`                         | `skills.paths`                 |
| `DEVSPACE_AGENT_DIR`                           | `skills.agentDir`              |
| `DEVSPACE_SUBAGENTS`                           | `subagents.enabled`            |
| `DEVSPACE_LOG_LEVEL`                           | `logging.level`                |
| `DEVSPACE_LOG_FORMAT`                          | `logging.format`               |
| `DEVSPACE_LOG_REQUESTS`                        | `logging.requests`             |
| `DEVSPACE_LOG_ASSETS`                          | `logging.assets`               |
| `DEVSPACE_LOG_TOOL_CALLS`                      | `logging.toolCalls`            |
| `DEVSPACE_LOG_SHELL_COMMANDS`                  | `logging.shellCommands`        |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS`      | `oauth.accessTokenTtlSeconds`  |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS`     | `oauth.refreshTokenTtlSeconds` |
| `DEVSPACE_OAUTH_SCOPES`                        | `oauth.scopes`                 |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS`        | `oauth.allowedRedirectHosts`   |

These environment values are not read or auto-imported in v1.1. Environment is
process state, so there is no reliable file DevSpace can migrate on the user's
behalf.

## v1.0 file migration

The first v1.1 load performs one migration when `config.jsonc` is missing and
`config.json` exists:

1. Validate the old JSON document.
2. Translate its known fields into the versioned JSONC structure.
3. Write and validate a temporary `config.jsonc`.
4. Atomically publish it.
5. Rename the old file to `config.json.v1.0.bak`.

If `config.jsonc` exists, DevSpace never reads `config.json`. Invalid JSONC also
never falls back to the old file. Unsupported legacy keys stop migration with an
actionable error instead of being silently discarded.

The persisted fields map as follows:

| v1.0 JSON field                            | v1.1 JSONC key                                       |
| ------------------------------------------ | ---------------------------------------------------- |
| `host`, `port`                             | `server.host`, `server.port`                         |
| `publicBaseUrl`, `allowedHosts`            | `server.publicBaseUrl`, `server.allowedHosts`        |
| `allowedRoots`, `worktreeRoot`             | `workspaces.allowedRoots`, `workspaces.worktreeRoot` |
| `stateDir`                                 | `storage.stateDir`                                   |
| `artifactsEnabled`, `artifactMaxFileBytes` | `artifacts.enabled`, `artifacts.maxFileBytes`        |
| `agentDir`                                 | `skills.agentDir`                                    |
| `subagents`                                | `subagents`                                          |
| `tools.mode`, `ui.enabled`                 | unchanged nested keys                                |

`auth.json` is unchanged.
