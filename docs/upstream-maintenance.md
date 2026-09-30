# Upstream maintenance

The local/memory-integration branch is a compatibility-preserving DevSpace fork,
not a separate product line. Fork-local capabilities should remain additive and
should continue to follow upstream whenever the two designs are not genuinely
incompatible.

## Current checkpoint

As of 2026-09-30:

- upstream remote: https://github.com/Waishnav/devspace.git
- fork remote: https://github.com/LRSnowX/devspace.git
- upstream/main: 531d3f973f09f7b6b4993c9ff58f80a4514b9ba2
- local/memory-integration: c53b2d86329f96aad7aae092030c4c64952a4185
- merge base: 531d3f973f09f7b6b4993c9ff58f80a4514b9ba2
- divergence: 0 upstream-only commits, 24 fork-only commits

The fork is therefore not currently behind upstream main. Do not create a
maintenance merge merely to rewrite history or reduce the commit count.

## Sync trigger

Reassess upstream as soon as upstream/main moves. Prefer a small early sync over
accumulating many upstream commits and resolving a large semantic merge later.

A sync review should answer:

1. Which upstream commits affect files already modified by the fork?
2. Is the overlap textual only, or does it change the same runtime contract?
3. Can the fork-local behavior remain behind an additive module or adapter?
4. Did upstream add an equivalent capability that should replace local code?
5. Do migrations, MCP schemas, packaged entry points, or runtime activation
   require special compatibility handling?

Do not classify dependency-owned behavior by parsing human-readable error text
just to make an upstream change fit the fork.

## High-conflict surfaces

The current fork has the largest direct modifications in these upstream-owned
production files:

- src/apply-patch.ts
- src/server.ts
- src/cli.ts
- src/tool-surfaces/codex.ts
- src/pi-tools.ts
- src/tool-surfaces/claude.ts
- src/workspace-store.ts
- src/git-worktrees.ts
- src/workspaces.ts
- src/db/migrations.ts

Review these files first when upstream moves. A clean textual merge in one of
these files is not sufficient evidence of semantic compatibility.

By contrast, fork-local modules such as patch-recovery.ts,
patch-transaction-store.ts, retention.ts, memory-adapter.ts,
project-registry.ts, and tool-errors.ts are intentionally separate seams. New
fork work should prefer this pattern and keep server.ts / cli.ts wiring thin.

## Experimental upstream branches

Upstream v1.1 development currently includes experimental runtime/configuration
branches such as feat/v11-config-runtime-refactor. Treat these as directional
signals, not merge targets, until the work lands on upstream main or an official
release branch.

The notable direction is toward explicit runtime/config composition, including
new harness, presentation, and runtime-config seams. Fork-local changes should
avoid deepening server.ts / cli.ts coupling so future adoption of that structure
remains straightforward.

## Safe sync procedure

Use the existing upstream remote and keep the fork branch independently
reviewable:

    git fetch upstream main
    git rev-list --left-right --count upstream/main...local/memory-integration
    git diff --stat upstream/main...local/memory-integration

When upstream/main has moved, inspect the upstream commits and overlapping
files before choosing merge or rebase. Do not force-push shared fork history as
part of routine maintenance.

After resolving a sync:

- run focused tests for every overlapping runtime contract;
- run the full test suite and production build;
- inspect the final diff;
- verify packaged/runtime consumption when the change affects the installed
  DevSpace path or MCP schema;
- commit and push as one explicit maintenance slice.

No pull request is required unless explicitly requested.
