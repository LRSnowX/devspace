import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { fileRevision } from "./file-revision.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer, createServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { ProjectRegistry } from "./project-registry.js";
import type { MemoryClient, MemoryBootstrapContext } from "./memory-adapter.js";

const execFileAsync = promisify(execFile);

test("tool modes expose the expected host-facing tool surface", async (t) => {
  const cases: Array<{
    mode: ToolMode;
    expected: string[];
  }> = [
    {
      mode: "claude",
      expected: ["open_workspace", "read", "write", "edit", "bash", "show_changes"],
    },
    {
      mode: "codex",
      expected: ["open_workspace", "read", "apply_patch", "exec_command", "write_stdin", "show_changes"],
    },
  ];

  for (const { mode, expected } of cases) {
    await t.test(mode, async (nested) => {
      const context = await fixture(nested, { toolMode: mode, uiEnabled: false });
      const tools = await context.client.listTools();

      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        expected.sort(),
      );
    });
  }
});

test("model-facing tool schemas use snake_case recursively", async (t) => {
  for (const toolMode of ["claude", "codex"] as const) {
    await t.test(toolMode, async (nested) => {
      const context = await fixture(nested, { toolMode, uiEnabled: false });
      const tools = await context.client.listTools();
      const invalidPaths = tools.tools.flatMap((tool) => [
        ...schemaPropertyPaths(tool.inputSchema)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.input.${path}`),
        ...schemaPropertyPaths(tool.outputSchema)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.output.${path}`),
      ]);

      assert.deepEqual(invalidPaths, []);
    });
  }
});

test("Codex process tools bound model-facing yield windows to 12 seconds", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const tools = await context.client.listTools();

  for (const toolName of ["exec_command", "write_stdin"] as const) {
    const tool = tools.tools.find(({ name }) => name === toolName);
    const yieldSchema = tool?.inputSchema?.properties?.yield_time_ms as {
      maximum?: number;
      description?: string;
    } | undefined;

    assert.equal(yieldSchema?.maximum, 12_000);
    assert.match(yieldSchema?.description ?? "", /maximum 12000/i);
  }
});

test("Codex read and apply_patch expose the stale-read revision contract", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const tools = await context.client.listTools();
  const readTool = tools.tools.find(({ name }) => name === "read");
  const patchTool = tools.tools.find(({ name }) => name === "apply_patch");
  const patchInputProperties = patchTool?.inputSchema?.properties ?? {};
  const readOutputProperties = (readTool?.outputSchema as {
    properties?: Record<string, unknown>;
  } | undefined)?.properties ?? {};

  assert.deepEqual(
    Object.keys(patchInputProperties).sort(),
    ["expected_revisions", "patch", "workspace_id"],
  );
  assert.equal("revision" in readOutputProperties, true);

  const expectedRevisions = patchInputProperties.expected_revisions as {
    items?: {
      properties?: Record<string, unknown>;
    };
  } | undefined;
  assert.deepEqual(
    Object.keys(expectedRevisions?.items?.properties ?? {}).sort(),
    ["path", "revision"],
  );
});

test("read revisions reject stale Codex patches before publication", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "revision-protection"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "note.txt"), "original\nshared\n");

  const firstPage = structuredContent(await context.client.callTool({
    name: "read",
    arguments: {
      workspace_id: workspaceId,
      path: "note.txt",
      offset: 1,
      limit: 1,
    },
  }));
  const secondPage = structuredContent(await context.client.callTool({
    name: "read",
    arguments: {
      workspace_id: workspaceId,
      path: "note.txt",
      offset: 2,
      limit: 1,
    },
  }));
  assert.match(String(firstPage.revision), /^sha256:[0-9a-f]{64}$/);
  assert.equal(firstPage.revision, secondPage.revision);

  await writeFile(join(context.project, "note.txt"), "external\nshared\n");
  const stale = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspace_id: workspaceId,
      patch: [
        "*** Begin Patch",
        "*** Update File: note.txt",
        "@@",
        "-shared",
        "+patched",
        "*** End Patch",
      ].join("\n"),
      expected_revisions: [{
        path: "note.txt",
        revision: firstPage.revision,
      }],
    },
  });
  assert.notEqual(stale.isError, true);
  const staleStructured = structuredContent(stale);
  assert.equal(staleStructured.status, "error");
  assert.deepEqual(staleStructured.error, {
    code: "REVISION_CONFLICT",
    category: "conflict",
    message: `Invalid patch: stale file revision for note.txt: expected ${firstPage.revision}: current ${fileRevision(Buffer.from("external\nshared\n"))}`,
    retryable: true,
    path: "note.txt",
    expected_revision: firstPage.revision,
    current_revision: fileRevision(Buffer.from("external\nshared\n")),
  });
  assert.equal(staleStructured.additions, 0);
  assert.equal(staleStructured.removals, 0);
  assert.deepEqual(staleStructured.files, []);
  const staleContent = stale.content as Array<{
    type: string;
    text?: string;
  }>;
  assert.match(
    staleContent
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join("\n"),
    /stale file revision for note\.txt/,
  );
  assert.equal(
    await readFile(join(context.project, "note.txt"), "utf8"),
    "external\nshared\n",
  );

  const refreshed = structuredContent(await context.client.callTool({
    name: "read",
    arguments: {
      workspace_id: workspaceId,
      path: "note.txt",
    },
  }));
  assert.notEqual(refreshed.revision, firstPage.revision);

  const applied = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspace_id: workspaceId,
      patch: [
        "*** Begin Patch",
        "*** Update File: note.txt",
        "@@",
        "-shared",
        "+patched",
        "*** End Patch",
      ].join("\n"),
      expected_revisions: [{
        path: "note.txt",
        revision: refreshed.revision,
      }],
    },
  });
  assert.equal(applied.isError, undefined);
  assert.equal(
    await readFile(join(context.project, "note.txt"), "utf8"),
    "external\npatched\n",
  );
});

test("Codex apply_patch exposes structured workspace and path errors", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });

  const missingWorkspace = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspace_id: "ws_missing",
      patch: [
        "*** Begin Patch",
        "*** Add File: note.txt",
        "+hello",
        "*** End Patch",
      ].join("\n"),
    },
  });
  assert.notEqual(missingWorkspace.isError, true);
  assert.equal(structuredContent(missingWorkspace).status, "error");
  assert.deepEqual(structuredContent(missingWorkspace).error, {
    code: "WORKSPACE_NOT_FOUND",
    category: "not_found",
    message:
      "Unknown workspaceId: ws_missing. Open the target project or worktree again and continue with the new workspaceId.",
    retryable: true,
  });

  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "structured-path-error"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const escapedPath = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspace_id: workspaceId,
      patch: [
        "*** Begin Patch",
        "*** Add File: ../outside.txt",
        "+hello",
        "*** End Patch",
      ].join("\n"),
    },
  });
  assert.notEqual(escapedPath.isError, true);
  assert.equal(structuredContent(escapedPath).status, "error");
  assert.deepEqual(structuredContent(escapedPath).error, {
    code: "PATH_SCOPE_VIOLATION",
    category: "scope",
    message: "Invalid patch: path escapes the workspace: ../outside.txt",
    retryable: false,
    path: "../outside.txt",
  });
});

test("Codex apply_patch blocks a fourth identical domain failure and resets on a changed request", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "repeat-failure-circuit"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "note.txt"), "current\nshared\n");
  const staleRevision = fileRevision(Buffer.from("old\nshared\n"));
  const patch = [
    "*** Begin Patch",
    "*** Update File: note.txt",
    "@@",
    "-shared",
    "+patched",
    "*** End Patch",
  ].join("\n");

  for (let count = 1; count <= 3; count += 1) {
    const failed = structuredContent(await context.client.callTool({
      name: "apply_patch",
      arguments: {
        workspace_id: workspaceId,
        patch,
        expected_revisions: [{ path: "note.txt", revision: staleRevision }],
      },
    }));
    assert.equal(failed.status, "error");
    assert.equal((failed.error as { code?: string }).code, "REVISION_CONFLICT");
  }

  const blocked = structuredContent(await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspace_id: workspaceId,
      patch,
      expected_revisions: [{ path: "note.txt", revision: staleRevision }],
    },
  }));
  assert.deepEqual(blocked.error, {
    code: "REPEATED_FAILURE",
    category: "state",
    message:
      "Repeated identical apply_patch request blocked after 3 consecutive failures. Change the patch or expected revisions, or re-read the relevant files before retrying.",
    retryable: false,
    repeat_count: 3,
    previous_error_code: "REVISION_CONFLICT",
  });
  assert.equal(
    await readFile(join(context.project, "note.txt"), "utf8"),
    "current\nshared\n",
  );

  const currentRevision = fileRevision(Buffer.from("current\nshared\n"));
  const applied = structuredContent(await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspace_id: workspaceId,
      patch,
      expected_revisions: [{ path: "note.txt", revision: currentRevision }],
    },
  }));
  assert.equal(applied.status, "applied");

  await writeFile(join(context.project, "note.txt"), "external\nshared\n");
  const afterSuccess = structuredContent(await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspace_id: workspaceId,
      patch,
      expected_revisions: [{ path: "note.txt", revision: currentRevision }],
    },
  }));
  assert.equal((afterSuccess.error as { code?: string }).code, "REVISION_CONFLICT");
});

test("Claude edit and bash tools accept snake_case runtime inputs", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "snake-case-claude"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "note.txt"), "before\n");
  await mkdir(join(context.project, "nested"));

  const edited = await context.client.callTool({
    name: "edit",
    arguments: {
      workspace_id: workspaceId,
      path: "note.txt",
      edits: [{ old_text: "before", new_text: "after" }],
    },
  });
  assert.equal(edited.isError, undefined);
  assert.equal(await readFile(join(context.project, "note.txt"), "utf8"), "after\n");

  const shell = structuredContent(await context.client.callTool({
    name: "bash",
    arguments: {
      workspace_id: workspaceId,
      command: "pwd",
      working_directory: "nested",
    },
  }));
  assert.match(shell.result as string, /nested/i);
});

test("read rejects a symlink that leaves the workspace", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const outside = await mkdtemp(join(tmpdir(), "devspace-server-outside-test-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.txt"), "outside secret\n");

  const outsideLink = join(context.project, "outside-link");
  await symlink(outside, outsideLink, platform() === "win32" ? "junction" : "dir");
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "symlink-read"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const result = await context.client.callTool({
    name: "read",
    arguments: { workspace_id: workspaceId, path: "outside-link/secret.txt" },
  });
  assert.equal(result.isError, true);
});

test("write rejects a new file through a symlink that leaves the workspace", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const outside = await mkdtemp(join(tmpdir(), "devspace-server-outside-test-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));

  const outsideLink = join(context.project, "outside-link");
  await symlink(outside, outsideLink, platform() === "win32" ? "junction" : "dir");
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "symlink-write"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const result = await context.client.callTool({
    name: "write",
    arguments: {
      workspace_id: workspaceId,
      path: "outside-link/new.txt",
      content: "escaped\n",
    },
  });
  assert.equal(result.isError, true);
  await assert.rejects(access(join(outside, "new.txt")));
});

test("UI metadata is limited to workspace and aggregate review", async (t) => {
  for (const uiEnabled of [true, false]) {
    await t.test(uiEnabled ? "enabled" : "disabled", async (nested) => {
      const context = await fixture(nested, { toolMode: "claude", uiEnabled });
      const tools = await context.client.listTools();
      const toolsWithUi = tools.tools
        .filter((tool) => Boolean((tool._meta as { ui?: unknown } | undefined)?.ui))
        .map((tool) => tool.name)
        .sort();

      assert.deepEqual(toolsWithUi, uiEnabled ? ["open_workspace", "show_changes"] : []);
    });
  }
});

test("open_workspace reports aggregate review availability", async (t) => {
  const plain = await fixture(t);
  const gitWorkspace = await fixture(t, { git: true });

  const plainReview = structuredContent(await callOpen(plain.client, plain.project, "plain")).review;
  const gitReview = structuredContent(await callOpen(gitWorkspace.client, gitWorkspace.project, "git")).review;

  assert.equal((plainReview as { available: boolean }).available, false);
  assert.deepEqual(gitReview, { available: true });
});

test("show_changes reviews an unborn repository through the MCP tool surface", async (t) => {
  const context = await fixture(t, { uiEnabled: false });
  await git(context.project, ["init"]);

  const opened = structuredContent(await callOpen(context.client, context.project, "unborn-review"));
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");
  assert.deepEqual(opened.review, { available: true });

  await writeFile(join(context.project, "created-after-open.txt"), "new file\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  const card = responseCard(review);

  assert.deepEqual(card.files, [
    {
      path: "created-after-open.txt",
      type: "new",
      additions: 1,
      removals: 0,
    },
  ]);
  assert.match(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /new file/,
  );
  await assert.rejects(() => execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: context.project,
  }));
});

test("show_changes keeps model output compact and preserves the rich review card", async (t) => {
  const context = await fixture(t, { git: true, uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "review"),
  );
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "goodbye\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  const structured = structuredContent(review);
  assert.equal((review._meta as Record<string, unknown> | undefined)?.tool, undefined);

  assert.equal(structured.workspace_id, workspaceId);
  assert.equal("workspaceId" in structured, false);
  assert.match(structured.review_ref as string, /^[0-9a-f]{40,64}$/);
  assert.equal("summary" in structured, false);
  assert.equal("files" in structured, false);
  assert.equal("patch" in structured, false);

  const card = responseCard(review);
  assert.deepEqual(card.summary, {
    files: 1,
    additions: 1,
    removals: 1,
  });
  assert.deepEqual(card.files, [
    {
      path: "README.md",
      type: "change",
      additions: 1,
      removals: 1,
    },
  ]);
  assert.match(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /-hello\n\+goodbye/,
  );

  const tools = await context.client.listTools();
  const outputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.outputSchema?.properties;
  assert.ok(outputProperties && "workspace_id" in outputProperties);
  assert.equal(outputProperties && "workspaceId" in outputProperties, false);
  assert.ok(outputProperties && "review_ref" in outputProperties);
  assert.equal(outputProperties && "summary" in outputProperties, false);
  assert.equal(outputProperties && "files" in outputProperties, false);
  assert.equal(outputProperties && "patch" in outputProperties, false);
  const inputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.inputSchema?.properties;
  assert.equal(inputProperties && "reviewRef" in inputProperties, false);
});

test("show_changes can reopen a historical review without advancing the checkpoint", async (t) => {
  const context = await fixture(t, { git: true });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "review-history"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "first\n");
  const first = structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  }));
  const reviewRef = first.review_ref;
  assert.equal(typeof reviewRef, "string");

  await writeFile(join(context.project, "README.md"), "second\n");
  const reopened = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
    _meta: { "devspace/reviewRef": reviewRef },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(reopened).review_ref, reviewRef);
  assert.match(
    (((responseCard(reopened).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /\+first/,
  );

  const current = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  assert.match(
    (((responseCard(current).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /-first\n\+second/,
  );
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  assert.equal((first._meta as Record<string, unknown> | undefined)?.tool, undefined);
  assert.equal((repeated._meta as Record<string, unknown> | undefined)?.tool, undefined);

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.ok(outputProperties && "workspace_id" in outputProperties);
  assert.equal(outputProperties && "workspaceId" in outputProperties, false);
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  const providerSchema = outputProperties?.agent_providers as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(typeof firstStructured.workspace_id, "string");
  assert.equal("workspaceId" in firstStructured, false);
  assert.equal(firstStructured.workspace_id, structuredContent(repeated).workspace_id);
  assert.ok(Array.isArray(firstStructured.agents_files));
  assert.ok(Array.isArray(firstStructured.available_agents_files));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agent_providers));
  assert.equal(
    (firstStructured.agent_providers as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstStructured.agent_providers as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skill_diagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.match(firstStructured.instruction as string, /workspace_id/);
  assert.match(repeatedStructured.instruction as string, /workspace_id/);
  assert.doesNotMatch(firstStructured.instruction as string, /workspaceId/);
  assert.doesNotMatch(repeatedStructured.instruction as string, /workspaceId/);
  assert.equal(repeatedStructured.agents_files, undefined);
  assert.equal(repeatedStructured.available_agents_files, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agent_providers, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skill_diagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.equal(
    (card.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;
  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(unavailable.agent_providers, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agent_providers as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (usable.agents as Array<Record<string, unknown>>)[0]?.name,
    "reviewer",
  );
});

test("open_workspace omits providers disabled by configuration", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
    subagents: {
      enabled: true,
      instructions: "on-demand",
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agent_providers as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("open_workspace advertises subagent instructions on demand by default", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), true);
  assert.doesNotMatch(String(opened.instruction), /# DevSpace subagents/);
});

test("open_workspace preloads subagent instructions when configured", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    subagents: {
      enabled: true,
      instructions: "preload",
      providers: [{ id: "codex", enabled: true }],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), false);
  assert.match(String(opened.instruction), /# DevSpace subagents/);
});

test("open_workspace scopes checkout reuse to OpenAI session metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  const otherSession = await callOpen(context.client, context.project, "chat-2");
  const unscoped = await callOpen(context.client, context.project);

  assert.equal(structuredContent(repeated).workspace_id, structuredContent(first).workspace_id);
  assert.equal(structuredContent(repeated).agents_files, undefined);
  assert.notEqual(structuredContent(otherSession).workspace_id, structuredContent(first).workspace_id);
  assert.notEqual(structuredContent(unscoped).workspace_id, structuredContent(first).workspace_id);
  assert.ok(Array.isArray(structuredContent(otherSession).agents_files));
  assert.ok(Array.isArray(structuredContent(unscoped).agents_files));
});

test("HTTP endpoint serves modern MCP and stateless legacy clients", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-modern-http-test-",
  );

  const unauthenticated = await postModernMcp(
    localBaseUrl,
    undefined,
    "tools/list",
    {},
  );
  assert.equal(unauthenticated.status, 401, await unauthenticated.clone().text());

  const discovery = await postModernMcp(
    localBaseUrl,
    accessToken,
    "server/discover",
    {},
  );
  assert.equal(discovery.status, 200, await discovery.clone().text());
  const discoveryBody = await discovery.json() as {
    result?: { supportedVersions?: string[] };
  };
  assert.ok(discoveryBody.result?.supportedVersions?.includes("2026-07-28"));

  const listed = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/list",
    {},
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  const listBody = await listed.json() as {
    result?: { tools?: Array<{ name?: string }> };
  };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "open_workspace"));

  const called = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await called.json() as {
    result?: { structuredContent?: { workspace_id?: string; agents_files?: unknown[] } };
  };
  const workspaceId = callBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const repeated = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(repeated.status, 200, await repeated.clone().text());
  const repeatedBody = await repeated.json() as {
    result?: { structuredContent?: { workspace_id?: string; agents_files?: unknown[] } };
  };
  assert.equal(repeatedBody.result?.structuredContent?.workspace_id, workspaceId);
  assert.equal(repeatedBody.result?.structuredContent?.agents_files, undefined);

  const legacy = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "devspace-legacy-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(legacy.status, 200, await legacy.clone().text());
  assert.equal(legacy.headers.get("mcp-session-id"), null);
  assert.match(await legacy.text(), /"protocolVersion"/);

  const legacyTools = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-tools-list",
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(legacyTools.status, 200, await legacyTools.clone().text());
  assert.equal(legacyTools.headers.get("mcp-session-id"), null);
  assert.match(await legacyTools.text(), /"open_workspace"/);
});

test("modern MCP memory discovery authorizes evidence across stateless requests", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-modern-memory-test-",
    fakeMemory(),
  );
  const listed = await postModernMcp(localBaseUrl, accessToken, "tools/list", {});
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as { result?: { tools?: Array<{ name: string; inputSchema?: unknown }> } };
  const names = listBody.result?.tools?.map((tool) => tool.name) ?? [];
  assert.deepEqual(names.filter((name) => name.startsWith("memory_")).sort(), ["memory_get_thread", "memory_search"]);
  for (const forbidden of ["resolve_project", "register_project", "memory_recent", "memory_project_context", "memory_import", "memory_delete"]) {
    assert.equal(names.includes(forbidden), false);
  }
  const memoryTools = listBody.result?.tools?.filter((tool) => tool.name.startsWith("memory_")) ?? [];
  assert.deepEqual(memoryTools.flatMap((tool) => schemaPropertyPaths(tool.inputSchema)
    .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))), []);

  const opened = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace",
    arguments: { path: root },
    _meta: { "openai/session": "memory-http-session" },
  });
  assert.equal(opened.status, 200, await opened.clone().text());
  const openBody = await opened.json() as { result?: { structuredContent?: { workspace_id?: string; project_name?: string; memory_context?: unknown } } };
  const workspaceId = openBody.result?.structuredContent?.workspace_id;
  const projectName = openBody.result?.structuredContent?.project_name;
  assert.equal(typeof workspaceId, "string");
  assert.equal(typeof projectName, "string");
  assert.ok(openBody.result?.structuredContent?.memory_context);

  const search = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "memory_search",
    arguments: { workspace_id: workspaceId, query: "decision", limit: 2 },
  });
  assert.equal(search.status, 200, await search.clone().text());
  const searchBody = await search.json() as { result?: { isError?: boolean; structuredContent?: { hits?: unknown[] } } };
  assert.notEqual(searchBody.result?.isError, true);
  assert.ok(searchBody.result?.structuredContent?.hits?.length);

  const expanded = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "memory_get_thread",
    arguments: { workspace_id: workspaceId, conversation_id: `${projectName}-search-evidence`, message_offset: 0, message_limit: 1 },
  });
  assert.equal(expanded.status, 200, await expanded.clone().text());
  const expandBody = await expanded.json() as { result?: { isError?: boolean } };
  assert.notEqual(expandBody.result?.isError, true);
  const denied = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "memory_get_thread",
    arguments: { workspace_id: workspaceId, conversation_id: "foreign-id" },
  });
  assert.equal(denied.status, 200, await denied.clone().text());
  const deniedBody = await denied.json() as { result?: { isError?: boolean } };
  assert.equal(deniedBody.result?.isError, true);
});

test("server shutdown waits for an active MCP tool call", async (t) => {
  const { root, localBaseUrl, accessToken, running } = await httpServerFixture(
    t,
    "devspace-shutdown-test-",
  );
  const opened = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "shutdown-test" },
    },
  );
  const openBody = await opened.json() as {
    result?: { structuredContent?: { workspace_id?: string } };
  };
  const workspaceId = openBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const command = [
    "const fs=require('node:fs')",
    "fs.writeFileSync('started','')",
    "const timer=setInterval(()=>{if(fs.existsSync('release')) clearInterval(timer)},10)",
  ].join(";");
  const toolCall = postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "exec_command",
      arguments: {
        workspace_id: workspaceId,
        cmd: `node -e \"${command}\"`,
        yield_time_ms: 12_000,
      },
    },
  );
  await waitForFile(join(root, "started"));

  let shutdownFinished = false;
  const shutdown = running.close().then(() => {
    shutdownFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shutdownFinished, false);

  await writeFile(join(root, "release"), "");
  await toolCall;
  await shutdown;
  assert.equal(shutdownFinished, true);
});

function fakeMemory(bootstrapFailure?: Error): MemoryClient {
  return {
    enabled: true,
    async bootstrapProjectContext(project): Promise<MemoryBootstrapContext> {
      if (bootstrapFailure) throw bootstrapFailure;
      return {
        project,
        sourcePolicy: "relevance-filter",
        relevant: [{
          conversationId: `${project}-parent`,
          evidenceConversationId: `${project}-evidence`,
          source: "chatgpt",
          title: "Decision",
          snippet: "Keep the project entry small.",
          topicTags: ["decision"],
        }],
        recent: [],
        truncated: false,
        byteBudget: 12_288,
      };
    },
    async call(toolName, args) {
      if (toolName === "memory_search") {
        return {
          content: [],
          structuredContent: {
            hits: [{
              result: { conversation_id: `${args.project}-search`, source: "chatgpt", title: "Search hit" },
              evidence_conversation_id: `${args.project}-search-evidence`,
            }],
          },
        };
      }
      if (toolName === "memory_get_thread") {
        return { content: [], structuredContent: {
          conversation_id: args.conversation_id,
          message_offset: args.message_offset,
          message_limit: args.message_limit,
          returned_messages: 1,
        } };
      }
      throw new Error(`Unexpected CHIM tool: ${toolName}`);
    },
  };
}

test("project entry resolves paths, names and aliases with workspace reuse", async (t) => {
  const context = await fixture(t, { projectRegistration: { name: "LEMonX", aliases: ["Lemon"] } });
  const tools = await context.client.listTools();
  assert.equal(tools.tools.some((tool) => ["resolve_project", "register_project"].includes(tool.name)), false);
  const absolute = structuredContent(await callOpen(context.client, context.project, "same-session"));
  const canonical = structuredContent(await callOpen(context.client, "LEMonX", "same-session"));
  const alias = structuredContent(await callOpen(context.client, "Lemon", "same-session"));
  assert.equal(canonical.workspace_id, absolute.workspace_id);
  assert.equal(alias.workspace_id, absolute.workspace_id);
  assert.equal(alias.project_name, "LEMonX");
  const discovered = structuredContent(await callOpen(context.client, "project", "same-session"));
  assert.equal(discovered.workspace_id, absolute.workspace_id);
  assert.equal(discovered.project_name, "LEMonX");
  const unknown = await callOpen(context.client, "missing-project");
  assert.equal(unknown.isError, true);
  const outside = await callOpen(context.client, join(context.root, ".."));
  assert.equal(outside.isError, true);
  const missing = join(context.root, "new-project");
  const created = structuredContent(await callOpen(context.client, missing, "same-session"));
  assert.equal(created.project_name, "new-project");
  assert.equal(created.root, missing);
});

test("ambiguous project entry is rejected", async (t) => {
  const extraRoot = await mkdtemp(join(tmpdir(), "devspace-entry-extra-"));
  await mkdir(join(extraRoot, "project"));
  t.after(async () => rm(extraRoot, { recursive: true, force: true }));
  const context = await fixture(t, { extraAllowedRoot: extraRoot });
  const result = await callOpen(context.client, "project");
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /ambiguous/);
});

test("memory surface is bounded, fail-open and progressive", async (t) => {
  const context = await fixture(t, {
    projectRegistration: { name: "LEMonX", aliases: ["Lemon"] },
    memoryClient: fakeMemory(),
  });
  const names = (await context.client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(names.filter((name) => name.startsWith("memory_")).sort(), ["memory_get_thread", "memory_search"]);
  const opened = structuredContent(await callOpen(context.client, "Lemon", "memory-session"));
  const workspaceId = opened.workspace_id as string;
  const bootstrap = opened.memory_context as Record<string, unknown>;
  assert.equal(opened.project_name, "LEMonX");
  assert.ok(Buffer.byteLength(JSON.stringify(bootstrap), "utf8") <= 12_288);
  assert.equal(bootstrap.byte_budget, 12_288);
  assert.equal("messages" in bootstrap, false);
  const denied = await context.client.callTool({
    name: "memory_get_thread",
    arguments: { workspace_id: workspaceId, conversation_id: "foreign-id" },
  });
  assert.equal(denied.isError, true);
  const bootstrapThread = await context.client.callTool({
    name: "memory_get_thread",
    arguments: { workspace_id: workspaceId, conversation_id: "LEMonX-evidence", message_offset: 0, message_limit: 1 },
  });
  assert.notEqual(bootstrapThread.isError, true);
  const search = await context.client.callTool({
    name: "memory_search",
    arguments: { workspace_id: workspaceId, query: "历史决策", limit: 2 },
  });
  assert.notEqual(search.isError, true);
  const expanded = await context.client.callTool({
    name: "memory_get_thread",
    arguments: { workspace_id: workspaceId, conversation_id: "LEMonX-search-evidence", message_offset: 1, message_limit: 2 },
  });
  assert.notEqual(expanded.isError, true);
  assert.equal(structuredContent(expanded).message_offset, 1);
  assert.equal(structuredContent(expanded).message_limit, 2);
  const otherProject = join(context.root, "other-project");
  await mkdir(otherProject);
  const other = structuredContent(await callOpen(context.client, otherProject, "memory-session"));
  const crossProject = await context.client.callTool({
    name: "memory_get_thread",
    arguments: { workspace_id: other.workspace_id, conversation_id: "LEMonX-search-evidence" },
  });
  assert.equal(crossProject.isError, true);
});

test("memory tools remain common to both upstream tool surfaces", async (t) => {
  for (const toolMode of ["claude", "codex"] as const) {
    await t.test(toolMode, async (nested) => {
      const context = await fixture(nested, { toolMode, memoryClient: fakeMemory() });
      const names = (await context.client.listTools()).tools.map((tool) => tool.name);
      assert.deepEqual(names.filter((name) => name.startsWith("memory_")).sort(), ["memory_get_thread", "memory_search"]);
    });
  }
});

test("model-facing memory bootstrap stays within byte budget after snake_case mapping", async (t) => {
  const memory = fakeMemory();
  const original = memory.bootstrapProjectContext;
  const oversized: MemoryClient = {
    ...memory,
    async bootstrapProjectContext(project) {
      const context = await original(project);
      return {
        ...context,
        relevant: [{ ...context.relevant[0]!, snippet: "x".repeat(20_000) }],
      };
    },
  };
  const context = await fixture(t, { memoryClient: oversized });
  const opened = structuredContent(await callOpen(context.client, context.project));
  const bootstrap = opened.memory_context as Record<string, unknown>;
  assert.ok(Buffer.byteLength(JSON.stringify(bootstrap), "utf8") <= 12_288);
  assert.equal(bootstrap.truncated, true);
});

test("memory bootstrap failures do not prevent coding workspace entry", async (t) => {
  for (const failure of ["unavailable", "malformed", "timeout"]) {
    await t.test(failure, async (nested) => {
      const context = await fixture(nested, { memoryClient: fakeMemory(new Error(failure)) });
      const result = structuredContent(await callOpen(context.client, context.project));
      assert.equal(typeof result.workspace_id, "string");
      assert.equal(result.memory_context, undefined);
    });
  }
});

interface ServerFixture {
  client: Client;
  project: string;
  root: string;
}

function schemaPropertyPaths(
  schema: unknown,
  prefix = "",
): Array<{ key: string; path: string }> {
  if (!schema || typeof schema !== "object") return [];
  const record = schema as {
    properties?: Record<string, unknown>;
    items?: unknown;
    anyOf?: unknown[];
    oneOf?: unknown[];
    allOf?: unknown[];
  };
  const paths = Object.entries(record.properties ?? {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [{ key, path }, ...schemaPropertyPaths(child, path)];
  });
  if (record.items) paths.push(...schemaPropertyPaths(record.items, `${prefix}[]`));
  for (const variant of [record.anyOf, record.oneOf, record.allOf]) {
    for (const child of variant ?? []) {
      paths.push(...schemaPropertyPaths(child, prefix));
    }
  }
  return paths;
}

interface HttpServerFixture {
  root: string;
  localBaseUrl: string;
  accessToken: string;
  running: ReturnType<typeof createServer>;
}

async function httpServerFixture(
  t: TestContext,
  prefix: string,
  memoryClient?: MemoryClient,
): Promise<HttpServerFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const ownerToken = "test-owner-token-that-is-long-enough";
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: {
      port: 1,
      publicBaseUrl: "https://example.test",
    },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, ".worktrees"),
    },
    storage: { stateDir: join(root, ".state") },
    memory: memoryClient ? { enabled: true, command: "/bin/false" } : undefined,
  }));
  const running = createServer(config, { incomingArtifactAdapters: [], memoryClient });
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const localBaseUrl = `http://127.0.0.1:${address.port}`;
  const accessToken = await issueTestAccessToken(
    localBaseUrl,
    config.publicBaseUrl,
    ownerToken,
  );
  return { root, localBaseUrl, accessToken, running };
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    toolMode?: ToolMode;
    uiEnabled?: boolean;
    memoryClient?: MemoryClient;
    projectRegistration?: { name: string; aliases?: string[] };
    extraAllowedRoot?: string;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const initialProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];
  const loadedConfig = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: options.extraAllowedRoot ? [root, options.extraAllowedRoot] : [root], worktreeRoot: join(root, ".worktrees") },
    memory: options.memoryClient ? { enabled: true, command: "/bin/false" } : undefined,
    skills: { agentDir },
    subagents: {
      enabled: options.localAgentProviders !== undefined,
      instructions: "on-demand",
      providers: [],
    },
  }));
  const modeConfig: ServerConfig = {
    ...loadedConfig,
    toolMode: options.toolMode ?? loadedConfig.toolMode,
    uiEnabled: options.uiEnabled ?? loadedConfig.uiEnabled,
  };
  const config: ServerConfig = options.localAgentProviders
    ? {
        ...modeConfig,
        subagents: options.subagents ?? {
          enabled: true,
          instructions: "on-demand",
          providers: initialProviderAvailability.map((provider) => ({
            id: provider.name,
            enabled: true,
          })),
        },
      }
    : modeConfig;
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
      ? options.localAgentProviders
      : () => initialProviderAvailability;
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );
  const store = new SqliteWorkspaceStore(stateDir);
  if (options.projectRegistration) {
    new ProjectRegistry(config.projectRegistryPath, config.allowedRoots).register({
      ...options.projectRegistration,
      path: project,
    });
  }
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
    undefined,
    options.memoryClient,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, root };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`Timed out waiting for ${path}`);
}

async function issueTestAccessToken(
  localBaseUrl: string,
  publicBaseUrl: string,
  ownerToken: string,
): Promise<string> {
  const redirectUri = "http://127.0.0.1/callback";
  const resource = new URL("/mcp", publicBaseUrl).href;
  const verifier = "devspace-modern-protocol-test-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetch(`${localBaseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "DevSpace modern protocol test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json() as { client_id?: string };
  assert.ok(client.client_id);

  const approval = await fetch(`${localBaseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "devspace",
      resource,
      state: "modern-test",
      owner_token: ownerToken,
    }),
    redirect: "manual",
  });
  assert.equal(approval.status, 302, await approval.clone().text());
  const location = approval.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);

  const exchange = await fetch(`${localBaseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = await exchange.json() as { access_token?: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}

function postModernMcp(
  localBaseUrl: string,
  accessToken: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  const mcpName = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string"
      ? params.uri
      : undefined;
  return fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(mcpName ? { "mcp-name": mcpName } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          ...recordValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "devspace-modern-http-test",
            version: "1.0.0",
          },
        },
      },
    }),
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: { path },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
