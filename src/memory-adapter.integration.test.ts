import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const workspacePath = process.env.DEVSPACE_MEMORY_TEST_WORKSPACE;
const memoryCommand = process.env.DEVSPACE_MEMORY_MCP_COMMAND;
const dataHome = process.env.DEVSPACE_MEMORY_DATA_HOME;
const expectedAnchor = process.env.DEVSPACE_MEMORY_EXPECTED_ANCHOR;
const foreignConversationId = process.env.DEVSPACE_MEMORY_FOREIGN_CONVERSATION_ID;
const searchQuery = process.env.DEVSPACE_MEMORY_TEST_QUERY
  ?? "为什么旧的数据库迁移记录不能重写";

test(
  "DevSpace proxies project-scoped memory tools to the configured read-only memory MCP",
  { skip: !workspacePath || !memoryCommand },
  async () => {
    assert.ok(workspacePath);
    assert.ok(memoryCommand);
    const temp = await mkdtemp(join(tmpdir(), "devspace-memory-e2e-"));
    const agentDir = join(temp, "agent");
    const stateDir = join(temp, "state");
    await mkdir(agentDir, { recursive: true });
    const config = loadConfig(writeTestDevspaceConfig(join(temp, "config"), {
      server: { port: 1 },
      workspaces: { allowedRoots: [dirname(workspacePath)], worktreeRoot: join(temp, "worktrees") },
      storage: { stateDir },
      skills: { enabled: false, agentDir },
      ui: { enabled: false },
      memory: { enabled: true, command: memoryCommand, dataHome: dataHome ?? null },
    }));
    const store = new SqliteWorkspaceStore(stateDir);
    const workspaces = new WorkspaceRegistry(config, store);
    const server = createMcpServer(
      config,
      workspaces,
      createReviewCheckpointManager(),
      new ProcessSessionManager(),
      () => [],
      [],
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "devspace-memory-e2e", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools
          .filter((tool) => tool.name.startsWith("memory_"))
          .map((tool) => tool.name)
          .sort(),
        ["memory_get_thread", "memory_search"],
      );

      const opened = await client.callTool({
        name: "open_workspace",
        arguments: { path: workspacePath, mode: "checkout" },
        _meta: { "openai/session": "memory-e2e-session" },
      });
      const workspaceId = readString(opened.structuredContent, "workspace_id");
      assert.ok(workspaceId);
      const bootstrap = readRecord(readRecord(opened.structuredContent)?.memory_context);
      assert.ok(bootstrap);
      assert.equal(readString(bootstrap, "project"), readString(opened.structuredContent, "project_name"));
      assert.ok(Buffer.byteLength(JSON.stringify(bootstrap), "utf8") <= 12_288);

      const byName = await client.callTool({
        name: "open_workspace",
        arguments: { path: basename(workspacePath) },
        _meta: { "openai/session": "memory-e2e-session" },
      });
      assert.equal(readString(byName.structuredContent, "workspace_id"), workspaceId);
      const homeRelative = relative(homedir(), workspacePath);
      if (!homeRelative.startsWith("..")) {
        const byTilde = await client.callTool({
          name: "open_workspace",
          arguments: { path: `~/${homeRelative}` },
          _meta: { "openai/session": "memory-e2e-session" },
        });
        assert.equal(readString(byTilde.structuredContent, "workspace_id"), workspaceId);
      }

      if (foreignConversationId) {
        const denied = await client.callTool({
          name: "memory_get_thread",
          arguments: {
            workspace_id: workspaceId,
            conversation_id: foreignConversationId,
            message_limit: 1,
          },
        });
        assert.equal(denied.isError, true);
      }

      const search = await client.callTool({
        name: "memory_search",
        arguments: { workspace_id: workspaceId, query: searchQuery, limit: 5 },
      });
      assert.notEqual(search.isError, true);
      const hits = readArray(search.structuredContent, "hits");
      assert.ok(hits.length > 0);
      const topAnchor = readNestedString(hits[0], ["result", "conversation_id"]);
      const evidenceId = readString(hits[0], "evidence_conversation_id");
      assert.ok(topAnchor);
      assert.ok(evidenceId);
      if (expectedAnchor) {
        assert.equal(topAnchor, expectedAnchor);
      }

      const thread = await client.callTool({
        name: "memory_get_thread",
        arguments: {
          workspace_id: workspaceId,
          conversation_id: evidenceId,
          message_limit: 5,
        },
      });
      assert.notEqual(thread.isError, true);
      assert.ok(readNumber(thread.structuredContent, "returned_messages") > 0);

    } finally {
      await client.close();
      await server.close();
      store.close();
      await rm(temp, { recursive: true, force: true });
    }
  },
);

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const field = readRecord(value)?.[key];
  return typeof field === "string" ? field : undefined;
}

function readNumber(value: unknown, key: string): number {
  const field = readRecord(value)?.[key];
  return typeof field === "number" ? field : 0;
}

function readArray(value: unknown, key: string): unknown[] {
  const field = readRecord(value)?.[key];
  return Array.isArray(field) ? field : [];
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = readRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}
