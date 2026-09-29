import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryAdapter,
  MemoryThreadAuthorizationStore,
  compactMemoryBootstrapContext,
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
