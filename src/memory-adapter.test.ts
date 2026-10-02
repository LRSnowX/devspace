import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  MemoryAdapter,
  MemoryThreadAuthorizationStore,
  compactMemoryBootstrapContext,
  compactMirroredMemoryResult,
  memoryEvidenceIdsFromBootstrapContext,
  memoryEvidenceIdsFromSearchResult,
} from "./memory-adapter.js";

function projectContext(snippet = "state"): CallToolResult {
  const hit = {
    result: {
      conversation_id: "parent-1",
      source: "chatgpt",
      title: "Project handoff",
      update_time: 42,
      snippet,
      topic_tags: ["decision", "blocker"],
    },
    evidence_conversation_id: "evidence-1",
  };
  return {
    content: [{ type: "text", text: "context" }],
    structuredContent: {
      project: "Jack",
      source_policy: "chatgpt-first-fallback-all",
      relevant: Array.from({ length: 4 }, () => hit),
      recent: Array.from({ length: 3 }, () => hit),
    },
  };
}

test("memory bootstrap compacts CHIM context within its byte budget without thread messages", () => {
  const context = compactMemoryBootstrapContext(projectContext("x".repeat(20_000)), "Jack", 2_048);
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 2_048);
  assert.equal(context.truncated, true);
  assert.equal("messages" in context, false);
  assert.ok(context.relevant.length > 0);
  assert.ok(context.relevant[0]!.snippet!.length <= 900);
});

test("memory bootstrap rejects malformed responses", () => {
  assert.throws(
    () => compactMemoryBootstrapContext({ structuredContent: { project: "Jack" } }, "Jack", 12_288),
    /Malformed memory project context response/,
  );
});

test("memory bootstrap preserves recent continuation tails within its byte budget", () => {
  const raw = projectContext() as {
    structuredContent: Record<string, unknown>;
  };
  raw.structuredContent.continuations = [
    {
      conversation_id: "continuation-1",
      source: "chatgpt",
      title: "Current project chat",
      update_time: 100,
      message_offset: 0,
      returned_messages: 3,
      total_messages: 3,
      messages: Array.from({ length: 3 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        create_time: 100 + index,
        turn_index: index,
        text: `current-${index}-${"x".repeat(200)}`,
      })),
    },
    {
      conversation_id: "continuation-2",
      source: "chatgpt",
      title: "Previous project chat",
      update_time: 99,
      message_offset: 10,
      returned_messages: 8,
      total_messages: 18,
      messages: Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        create_time: 90 + index,
        turn_index: 10 + index,
        text: `previous-${index}-${"x".repeat(1_000)}`,
      })),
    },
  ];

  const context = compactMemoryBootstrapContext(raw, "Jack", 4_096);
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 4_096);
  assert.equal(context.continuations.length, 2);
  assert.equal(context.continuations[0]?.conversationId, "continuation-1");
  assert.equal(context.continuations[0]?.messages.length, 3);
  assert.equal(context.continuations[1]?.conversationId, "continuation-2");
  assert.equal(context.continuations[1]?.messages.at(-1)?.turnIndex, 17);
  assert.ok((context.continuations[1]?.messages.length ?? 0) > 0);
  assert.ok((context.continuations[1]?.messageOffset ?? 0) >= 10);
  assert.equal(context.truncated, true);
  assert.ok(memoryEvidenceIdsFromBootstrapContext(context).includes("continuation-1"));
  assert.ok(memoryEvidenceIdsFromBootstrapContext(context).includes("continuation-2"));
});

test("memory bootstrap prioritizes bounded working memory before continuation history", () => {
  const raw = projectContext() as {
    structuredContent: Record<string, unknown>;
  };
  raw.structuredContent.working_memory = {
    project: "Jack",
    generated_at: 123,
    items: Array.from({ length: 8 }, (_, index) => ({
      memory_id: "memory-" + index,
      scope: { type: "project", project: "Jack" },
      kind: index === 0 ? "decision" : "state",
      key: "key-" + index,
      value: { text: "memory-" + index + "-" + "m".repeat(900) },
      status: "active",
      importance: 100 - index,
      confidence: 1,
      valid_from: 100 + index,
      valid_until: null,
      supersedes_memory_id: null,
      created_at: 100 + index,
      updated_at: 100 + index,
      last_verified_at: 100 + index,
      evidence: [{
        kind: "conversation_turn",
        reference: "conversation:private-" + index + ":turn:1",
        detail: {},
        created_at: 100 + index,
      }],
    })),
  };
  raw.structuredContent.continuations = [{
    conversation_id: "continuation-1",
    source: "chatgpt",
    title: "Previous chat",
    message_offset: 0,
    total_messages: 2,
    messages: [
      { role: "user", turn_index: 0, text: "continue" },
      { role: "assistant", turn_index: 1, text: "next action" },
    ],
  }];

  const context = compactMemoryBootstrapContext(raw, "Jack", 8_192);
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 8_192);
  assert.ok(context.workingMemory.items.length > 0);
  assert.equal(context.workingMemory.items[0]?.memoryId, "memory-0");
  assert.ok(context.workingMemory.items.length < 8);
  assert.equal(context.continuations.length, 1);
  assert.ok(context.continuations[0]!.messages.length > 0);
  assert.equal(context.truncated, true);
  assert.equal(
    memoryEvidenceIdsFromBootstrapContext(context).includes("private-0"),
    false,
  );
});

test("memory bootstrap compacts a single oversized working-memory value", () => {
  const raw = projectContext() as {
    structuredContent: Record<string, unknown>;
  };
  raw.structuredContent.working_memory = {
    project: "Jack",
    items: [{
      memory_id: "large-memory",
      kind: "state",
      key: "current_state",
      value: {
        nested: Array.from({ length: 40 }, (_, index) => ({
          index,
          text: "x".repeat(2_000),
        })),
      },
      importance: 100,
      confidence: 1,
      evidence: [],
    }],
  };

  const context = compactMemoryBootstrapContext(raw, "Jack", 4_096);
  assert.equal(context.workingMemory.items.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 4_096);
  const value = context.workingMemory.items[0]?.value as Record<string, unknown>;
  assert.equal(value.truncated, true);
  assert.equal(typeof value.preview, "string");
});

test("memory adapter removes rmcp mirrored JSON text when structured content is identical", () => {
  const structuredContent = {
    hits: [{ result: { conversation_id: "conversation-1" } }],
  };
  const compacted = compactMirroredMemoryResult({
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  });
  assert.deepEqual(compacted.content, []);
  assert.deepEqual(compacted.structuredContent, structuredContent);

  const nonMirrored = compactMirroredMemoryResult({
    content: [{ type: "text", text: "human-readable summary" }],
    structuredContent,
  });
  assert.equal(nonMirrored.content[0]?.type, "text");
});

test("memory evidence ids include bootstrap and search evidence anchors", () => {
  const context = compactMemoryBootstrapContext(projectContext(), "Jack", 12_288);
  assert.deepEqual(
    memoryEvidenceIdsFromBootstrapContext(context).sort(),
    ["evidence-1", "parent-1"],
  );
  assert.deepEqual(
    memoryEvidenceIdsFromSearchResult({
      structuredContent: {
        hits: [
          {
            result: { conversation_id: "parent-2" },
            evidence_conversation_id: "evidence-2",
          },
          {
            result: { conversation_id: "parent-2" },
            evidence_conversation_id: "evidence-2",
          },
        ],
      },
    }).sort(),
    ["evidence-2", "parent-2"],
  );
  assert.deepEqual(memoryEvidenceIdsFromSearchResult({ structuredContent: { hits: "bad" } }), []);
});

test("memory thread authorization is bounded and project scoped", () => {
  const store = new MemoryThreadAuthorizationStore(2);
  store.authorize("/projects/Jack", ["a", "b"]);
  assert.equal(store.isAuthorized("/projects/Jack", "a"), true);
  assert.equal(store.isAuthorized("/projects/Jill", "a"), false);

  store.authorize("/projects/Jack", ["c"]);
  assert.equal(store.isAuthorized("/projects/Jack", "a"), false);
  assert.equal(store.isAuthorized("/projects/Jack", "b"), true);
  assert.equal(store.isAuthorized("/projects/Jack", "c"), true);
});

test("memory thread authorization evicts old projects", () => {
  const store = new MemoryThreadAuthorizationStore(2, 2);
  store.authorize("first", ["one"]);
  store.authorize("second", ["two"]);
  store.authorize("third", ["three"]);
  assert.equal(store.isAuthorized("first", "one"), false);
  assert.equal(store.isAuthorized("second", "two"), true);
  assert.equal(store.isAuthorized("third", "three"), true);
});

test("memory bootstrap skips semantic retrieval and requests only recent continuation context", async () => {
  const adapter = new MemoryAdapter({
    enabled: true,
    command: "/bin/false",
    bootstrapTimeoutMs: 5_000,
    bootstrapByteBudget: 12_288,
  });
  let observedArgs: Record<string, unknown> | undefined;
  adapter.call = async (_toolName, args) => {
    observedArgs = args;
    return projectContext();
  };

  await adapter.bootstrapProjectContext("Jack");
  assert.equal(observedArgs?.project, "Jack");
  assert.equal(observedArgs?.relevant_limit, 0);
  assert.equal(observedArgs?.recent_limit, 3);
  assert.equal(observedArgs?.continuation_message_limit, 8);
});

test("memory bootstrap enforces its timeout", async () => {
  const adapter = new MemoryAdapter({
    enabled: true,
    command: "/bin/false",
    bootstrapTimeoutMs: 10,
    bootstrapByteBudget: 12_288,
  });
  adapter.call = async () => new Promise(() => undefined);
  await assert.rejects(() => adapter.bootstrapProjectContext("Jack"), /timed out/);
});
