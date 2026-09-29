import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { ProjectRegistry } from "./project-registry.js";
import {
  MemoryAdapter,
  MemoryThreadAuthorizationStore,
  type MemoryClient,
} from "./memory-adapter.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("memory tools are opt-in and read-only", async (t) => {
  const disabled = await fixture(t);
  const disabledTools = await disabled.client.listTools();
  assert.equal(
    disabledTools.tools.some((tool) => tool.name.startsWith("memory_")),
    false,
  );

  const enabled = await fixture(t, {
    memory: {
      enabled: true,
      command: "/bin/false",
      bootstrapTimeoutMs: 2_000,
      bootstrapByteBudget: 12_288,
    },
  });
  const enabledTools = await enabled.client.listTools();
  const memoryTools = enabledTools.tools
    .filter((tool) => tool.name.startsWith("memory_"))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(
    memoryTools.map((tool) => tool.name),
    ["memory_get_thread", "memory_search"],
  );
  for (const tool of memoryTools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.ok(
      (tool.inputSchema.properties as Record<string, unknown> | undefined)?.workspaceId,
      `${tool.name} should require workspaceId`,
    );
  }
});

test("open_workspace memory bootstrap and search authorize only project-scoped evidence", async (t) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const memory: MemoryClient = {
    enabled: true,
    async bootstrapProjectContext(project) {
      return {
        project,
        sourcePolicy: "chatgpt-first-fallback-all",
        relevant: [{
          conversationId: "parent-1",
          evidenceConversationId: "evidence-1",
          source: "chatgpt",
          title: "Current decision",
          snippet: "Keep the adapter fail-open.",
          topicTags: ["decision"],
        }],
        recent: [],
        truncated: false,
        byteBudget: 12_288,
      };
    },
    async call(name, args) {
      calls.push({ name, args });
      if (name === "memory_get_thread") {
        return {
          content: [{ type: "text", text: "thread" }],
          structuredContent: {
            thread: { messages: [{ role: "user", text: "evidence" }] },
            message_offset: args.message_offset ?? 0,
            returned_messages: 1,
            total_messages: 2,
            truncated: true,
          },
        };
      }
      return {
        content: [{ type: "text", text: "search" }],
        structuredContent: {
          project: args.project,
          retrieval_mode: "hybrid",
          hits: [{
            result: { conversation_id: "search-parent-1" },
            evidence_conversation_id: "search-evidence-1",
          }],
        },
      };
    },
  };
  const context = await fixture(t, {
    memory: {
      enabled: true,
      command: "/bin/false",
      bootstrapTimeoutMs: 50,
      bootstrapByteBudget: 12_288,
    },
    memoryClient: memory,
    projectRegistration: { name: "Jack", aliases: ["Jack助手"] },
  });
  const opened = structuredContent(await callOpen(context.client, "Jack助手", "chat-memory"));
  assert.equal((opened.memoryContext as Record<string, unknown>).project, "Jack");
  assert.ok(Buffer.byteLength(JSON.stringify(opened.memoryContext), "utf8") <= 12_288);

  const foreignBeforeSearch = await context.client.callTool({
    name: "memory_get_thread",
    arguments: { workspaceId: opened.workspaceId, conversationId: "foreign-project-thread" },
  });
  assert.equal(foreignBeforeSearch.isError, true);
  assert.match(responseText(foreignBeforeSearch), /not authorized by this project's memory discovery/);
  assert.equal(calls.length, 0, "unauthorized thread ids must not reach the memory backend");

  const bootstrapPage = await context.client.callTool({
    name: "memory_get_thread",
    arguments: { workspaceId: opened.workspaceId, conversationId: "evidence-1", messageOffset: 1, messageLimit: 1 },
  });
  assert.equal(structuredContent(bootstrapPage).truncated, true);

  const search = await context.client.callTool({
    name: "memory_search",
    arguments: { workspaceId: opened.workspaceId, query: "旧决定", limit: 3 },
  });
  assert.notEqual(search.isError, true);
  const searchPage = await context.client.callTool({
    name: "memory_get_thread",
    arguments: { workspaceId: opened.workspaceId, conversationId: "search-evidence-1" },
  });
  assert.equal(structuredContent(searchPage).truncated, true);

  const foreignAfterSearch = await context.client.callTool({
    name: "memory_get_thread",
    arguments: { workspaceId: opened.workspaceId, conversationId: "foreign-project-thread" },
  });
  assert.equal(foreignAfterSearch.isError, true);
  assert.deepEqual(calls, [
    { name: "memory_get_thread", args: { conversation_id: "evidence-1", message_offset: 1, message_limit: 1 } },
    { name: "memory_search", args: { query: "旧决定", project: "Jack", limit: 3 } },
    { name: "memory_get_thread", args: { conversation_id: "search-evidence-1", message_offset: undefined, message_limit: undefined } },
  ]);
  const invalidWorkspace = await context.client.callTool({
    name: "memory_search",
    arguments: { workspaceId: "ws_missing", query: "secret" },
  });
  assert.equal(invalidWorkspace.isError, true);
  assert.equal(calls.length, 3, "invalid workspace must not reach the memory backend");
});

test("memory evidence authorization survives separate MCP server sessions", async (t) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const authorizations = new MemoryThreadAuthorizationStore();
  const memory: MemoryClient = {
    enabled: true,
    async bootstrapProjectContext(project) {
      return {
        project,
        sourcePolicy: "chatgpt-first-fallback-all",
        relevant: [],
        recent: [],
        truncated: false,
        byteBudget: 12_288,
      };
    },
    async call(name, args) {
      calls.push({ name, args });
      if (name === "memory_search") {
        return {
          content: [{ type: "text", text: "search" }],
          structuredContent: {
            project: args.project,
            retrieval_mode: "hybrid",
            hits: [{
              result: { conversation_id: "search-parent" },
              evidence_conversation_id: "search-evidence",
            }],
          },
        };
      }
      if (name === "memory_get_thread") {
        return {
          content: [{ type: "text", text: "thread" }],
          structuredContent: {
            thread: { messages: [{ role: "user", text: "evidence" }] },
            message_offset: 0,
            returned_messages: 1,
            total_messages: 1,
            truncated: false,
          },
        };
      }
      throw new Error(`unexpected memory tool: ${name}`);
    },
  };
  const context = await fixture(t, {
    memory: {
      enabled: true,
      command: "/bin/false",
      bootstrapTimeoutMs: 50,
      bootstrapByteBudget: 12_288,
    },
    memoryClient: memory,
    memoryThreadAuthorizations: authorizations,
    projectRegistration: { name: "Jack" },
  });
  const opened = structuredContent(await callOpen(context.client, "Jack", "chat-memory-session-1"));
  const workspaceId = opened.workspaceId as string;

  const search = await context.client.callTool({
    name: "memory_search",
    arguments: { workspaceId, query: "decision", limit: 3 },
  });
  assert.notEqual(search.isError, true);

  const secondServer = createMcpServer(
    context.config,
    context.workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
    memory,
    authorizations,
  );
  const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
  const secondClient = new Client({ name: "devspace-second-session", version: "1.0.0" });
  await Promise.all([
    secondClient.connect(secondClientTransport),
    secondServer.connect(secondServerTransport),
  ]);
  try {
    const page = await secondClient.callTool({
      name: "memory_get_thread",
      arguments: { workspaceId, conversationId: "search-evidence" },
    });
    assert.notEqual(page.isError, true);

    const denied = await secondClient.callTool({
      name: "memory_get_thread",
      arguments: { workspaceId, conversationId: "foreign-evidence" },
    });
    assert.equal(denied.isError, true);
  } finally {
    await secondClient.close();
    await secondServer.close();
  }
});

test("open_workspace fails open when memory bootstrap is unavailable", async (t) => {
  const memory: MemoryClient = {
    enabled: true,
    async bootstrapProjectContext() {
      throw new Error("CHIM unavailable");
    },
    async call() {
      throw new Error("not called");
    },
  };
  const context = await fixture(t, {
    memory: {
      enabled: true,
      command: "/bin/false",
      bootstrapTimeoutMs: 50,
      bootstrapByteBudget: 12_288,
    },
    memoryClient: memory,
  });
  const opened = await callOpen(context.client, context.project, "chat-memory-fail-open");
  assert.notEqual(opened.isError, true);
  assert.equal(structuredContent(opened).memoryContext, undefined);
});

test("open_workspace fails open on memory timeout and malformed responses", async (t) => {
  for (const scenario of ["timeout", "malformed"] as const) {
    await t.test(scenario, async (subtest) => {
      const memoryConfig = {
        enabled: true,
        command: "/bin/false",
        bootstrapTimeoutMs: 10,
        bootstrapByteBudget: 12_288,
      };
      const memory = new MemoryAdapter(memoryConfig);
      memory.call = scenario === "timeout"
        ? async () => new Promise(() => undefined)
        : async () => ({
            content: [{ type: "text", text: "malformed" }],
            structuredContent: { project: "wrong-shape" },
          });
      const context = await fixture(subtest, { memory: memoryConfig, memoryClient: memory });
      const opened = await callOpen(context.client, context.project, `chat-${scenario}`);
      assert.notEqual(opened.isError, true);
      assert.equal(structuredContent(opened).memoryContext, undefined);
    });
  }
});

test("open_workspace is the only project-entry tool and resolves canonical names and aliases", async (t) => {
  const context = await fixture(t, { projectRegistration: { name: "Jack", aliases: ["Jack助手"] } });
  const tools = await context.client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "resolve_project"), false);
  assert.equal(tools.tools.some((tool) => tool.name === "register_project"), false);

  const canonical = structuredContent(await callOpen(context.client, "Jack", "chat-1"));
  const alias = structuredContent(await callOpen(context.client, "Jack助手", "chat-1"));
  const absolute = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.equal(canonical.root, context.project);
  assert.equal(canonical.projectName, "Jack");
  assert.equal(alias.workspaceId, canonical.workspaceId);
  assert.equal(alias.projectName, "Jack");
  assert.equal(absolute.workspaceId, canonical.workspaceId);
  assert.equal(absolute.projectName, "Jack");
});

test("open_workspace discovers unique directory names and rejects unknown or ambiguous projects", async (t) => {
  const context = await fixture(t);
  const discovered = structuredContent(await callOpen(context.client, "project", "chat-1"));
  assert.equal(discovered.root, context.project);

  const otherRoot = await mkdtemp(join(tmpdir(), "devspace-server-other-root-"));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  await mkdir(join(otherRoot, "project"));
  context.config.allowedRoots.push(otherRoot);

  const ambiguous = await callOpen(context.client, "project", "chat-2");
  assert.equal(ambiguous.isError, true);
  assert.match(responseText(ambiguous), /ambiguous across allowed roots/);
  const unknown = await callOpen(context.client, "missing", "chat-2");
  assert.equal(unknown.isError, true);
  assert.match(responseText(unknown), /Unknown project 'missing'/);
  const outside = await mkdtemp(join(tmpdir(), "devspace-server-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const denied = await callOpen(context.client, outside, "chat-2");
  assert.equal(denied.isError, true);
  assert.match(responseText(denied), /outside allowed roots/);
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  const providerSchema = outputProperties?.agentProviders as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
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
  assert.deepEqual(unavailable.agentProviders, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agentProviders as Array<Record<string, unknown>>)[0]?.id,
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
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agentProviders as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("concurrent checkout opens return one full context and one reuse instruction", async (t) => {
  const context = await fixture(t);
  const [first, second] = await Promise.all([
    callOpen(context.client, context.project, "chat-1"),
    callOpen(context.client, context.project, "chat-1"),
  ]);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.equal(
    [first, second].filter((result) => Array.isArray(structuredContent(result).agentsFiles)).length,
    1,
  );
  assert.equal(
    [first, second].filter((result) => responseText(result).includes("Workspace already open as")).length,
    1,
  );
});

test("new worktrees always receive a fresh workspace and complete worktree context", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const firstWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const secondWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.notEqual(structuredContent(firstWorktree).workspaceId, structuredContent(secondWorktree).workspaceId);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  for (const result of [firstWorktree, secondWorktree]) {
    const structured = structuredContent(result);
    assert.equal(structured.mode, "worktree");
    assert.ok(Array.isArray(structured.agentsFiles));
    assert.ok(Array.isArray(structured.availableAgentsFiles));
    assert.ok(Array.isArray(structured.skills));
    assert.ok(Array.isArray(structured.agentProviders));
    assert.ok(Array.isArray(structured.agents));
    assert.ok(Array.isArray(structured.skillDiagnostics));
    assert.match(responseText(result), /Opened isolated worktree workspace/);
  }
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
});

test("checkout opened after a worktree receives its own complete context", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(worktree).mode, "worktree");
  assert.ok(Array.isArray(structuredContent(worktree).agentsFiles));
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
});

test("a host without conversation metadata receives normal explicit-workspace behavior", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.notEqual(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout reuse and context suppression survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    () => [],
    [],
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
  } finally {
    await closeRestored();
  }
});

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  workspaces: WorkspaceRegistry;
  close: () => Promise<void>;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    memory?: ServerConfig["memory"];
    memoryClient?: MemoryClient;
    memoryThreadAuthorizations?: MemoryThreadAuthorizationStore;
    projectRegistration?: { name: string; aliases?: string[] };
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
  const loadedConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_SUBAGENTS: options.localAgentProviders ? "1" : "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const config: ServerConfig = {
    ...loadedConfig,
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.localAgentProviders
      ? {
          subagents: options.subagents ?? {
            enabled: true,
            providers: initialProviderAvailability.map((provider) => ({
              id: provider.name,
              enabled: true,
            })),
          },
        }
      : {}),
  };
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
      ? options.localAgentProviders
      : () => initialProviderAvailability;
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );
  if (options.projectRegistration) {
    new ProjectRegistry(config.projectRegistryPath, config.allowedRoots).register({
      ...options.projectRegistration,
      path: project,
    });
  }
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
    options.memoryClient,
    options.memoryThreadAuthorizations,
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

  return { client, project, config, stateDir, workspaces, close };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
    },
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

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
