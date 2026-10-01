import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryAdapter,
  MemoryThreadAuthorizationStore,
  compactMemoryBootstrapContext,
  compactMirroredMemoryResult,
  memoryEvidenceIdsFromBootstrapContext,
  memoryEvidenceIdsFromSearchResult,
} from "./memory-adapter.js";

function projectContext(snippet = "state"): Record<string, unknown> {
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

test("memory bootstrap prioritizes the latest continuation tail within its byte budget", () => {
  const raw = projectContext() as {
    structuredContent: Record<string, unknown>;
  };
  raw.structuredContent.continuation = {
    conversation_id: "continuation-1",
    source: "chatgpt",
    title: "Latest project chat",
    update_time: 99,
    message_offset: 10,
    returned_messages: 8,
    total_messages: 18,
    messages: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      create_time: 90 + index,
      turn_index: 10 + index,
      text: `message-${index}-${"x".repeat(1_000)}`,
    })),
  };

  const context = compactMemoryBootstrapContext(raw, "Jack", 4_096);
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 4_096);
  assert.ok(context.continuation);
  assert.equal(context.continuation.conversationId, "continuation-1");
  assert.equal(context.continuation.messages.at(-1)?.turnIndex, 17);
  assert.ok(context.continuation.messages.length > 0);
  assert.ok(context.continuation.messageOffset >= 10);
  assert.equal(context.truncated, true);
  assert.ok(memoryEvidenceIdsFromBootstrapContext(context).includes("continuation-1"));
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
