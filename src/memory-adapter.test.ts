import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { modelMemoryContext } from "./server.js";
import {
  MemoryAdapter,
  MemoryThreadAuthorizationStore,
  compactMemoryBootstrapContext,
  compactMirroredMemoryResult,
  memoryBootstrapSourceCounts,
  memoryContinuationByteBudget,
  memoryEvidenceIdsFromBootstrapContext,
  memoryEvidenceIdsFromSearchResult,
  memoryPendingByteBudget,
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

function staleHandoffContext() {
  const raw = projectContext() as { structuredContent: Record<string, unknown> };
  raw.structuredContent.relevant = [];
  raw.structuredContent.recent = [];
  raw.structuredContent.working_memory = {
    project: "Jack",
    items: Array.from({ length: 8 }, (_, index) => ({
      memory_id: `stale-${index}`,
      kind: "state",
      key: `state-${index}`,
      value: { text: "stale operational state ".repeat(40) },
      importance: 100,
      confidence: 1,
      last_verified_at: 1,
      evidence: [],
    })),
    verification: Array.from({ length: 8 }, (_, index) => ({
      memory_id: `stale-${index}`,
      class: "operational",
      evidence_strength: "conversation_only",
      state: "needs_revalidation",
    })),
  };
  raw.structuredContent.continuations = [
    {
      conversation_id: "fresh-continuation",
      source: "chatgpt",
      title: "Latest continuation",
      message_offset: 0,
      total_messages: 2,
      messages: [
        { role: "user", turn_index: 0, text: "Continue the current acceptance." },
        { role: "assistant", turn_index: 1, text: "Fresh next step: " + "e".repeat(650) },
      ],
    },
  ];
  return raw;
}

test("stale-heavy Working Memory preserves a useful recent continuation tail", () => {
  const raw = staleHandoffContext();
  const context = compactMemoryBootstrapContext(raw, "Jack", 3_072);
  assert.equal(context.continuations[0]?.messages.at(-1)?.turnIndex, 1);
  assert.match(context.continuations[0]?.messages.at(-1)?.text ?? "", /Fresh next step/);
  assert.ok(context.workingMemory.items.length > 0, "stale continuity remains visible");
  assert.equal(context.workingMemory.verification[0]?.sourceState, "needs_revalidation");
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 3_072);
  const packet = modelMemoryContext(context, 3_072);
  assert.equal(packet.continuations[0]?.messages.at(-1)?.turn_index, 1);
  assert.match(packet.continuations[0]?.messages.at(-1)?.text ?? "", /Fresh next step/);
  assert.ok(packet.working_memory.items.length > 0, "stale continuity remains visible on the wire");
  assert.equal(packet.bytes_used, Buffer.byteLength(JSON.stringify(packet), "utf8"));
  assert.ok(packet.sections.working_memory.truncated);
  assert.deepEqual(memoryEvidenceIdsFromBootstrapContext(context), ["fresh-continuation"]);
});

test("Host downgrades and every non-current source state lose protected budget before compaction", () => {
  const cases = [
    {
      source: "needs_revalidation",
      repository: { available: true, dirty: false },
      host: "needs_revalidation",
    },
    {
      source: "current_by_evidence",
      repository: { available: true, dirty: true },
      host: "needs_revalidation",
    },
    {
      source: "strongly_verified",
      repository: { available: true, dirty: false, headCommittedAt: 2 },
      host: "needs_revalidation",
    },
    { source: "tentative", repository: { available: true }, host: "tentative" },
    { source: "expired", repository: { available: true }, host: "expired" },
    { source: "unavailable", repository: { available: false }, host: "needs_revalidation" },
  ];
  for (const { source, repository, host } of cases) {
    const raw = staleHandoffContext();
    const working = raw.structuredContent.working_memory as {
      verification: Array<{ state: string }>;
    };
    for (const verification of working.verification) verification.state = source;
    const context = compactMemoryBootstrapContext(raw, "Jack", 3_072, undefined, repository);
    const packet = modelMemoryContext(context, 3_072, repository);
    assert.equal(packet.continuations[0]?.messages.at(-1)?.turn_index, 1, source);
    assert.ok(packet.working_memory.items.length > 0, source);
    assert.equal(packet.working_memory.verification[0]?.source_state, source);
    assert.equal(packet.working_memory.verification[0]?.host_state, host);
    assert.equal(packet.bytes_used, Buffer.byteLength(JSON.stringify(packet), "utf8"));
    assert.ok(packet.bytes_used <= 3_072);
    assert.equal(packet.working_memory.verification.length, packet.working_memory.items.length);
    assert.equal(packet.working_memory.confirmation.length, packet.working_memory.items.length);
  }
});

test("current operational and confirmed stable memory retain priority ahead of stale source order", () => {
  const raw = staleHandoffContext();
  const working = raw.structuredContent.working_memory as {
    items: Array<Record<string, unknown>>;
    verification: Array<Record<string, unknown>>;
    confirmation?: Array<Record<string, unknown>>;
  };
  working.items.push(
    {
      ...working.items[0],
      memory_id: "current-task",
      last_verified_at: 100,
      value: { text: "Current task " + "c".repeat(400) },
    },
    {
      ...working.items[0],
      memory_id: "confirmed-rule",
      kind: "decision",
      value: { text: "Confirmed rule " + "r".repeat(200) },
    },
  );
  working.verification.push(
    {
      memory_id: "current-task",
      class: "operational",
      evidence_strength: "strong_independent",
      state: "strongly_verified",
    },
    {
      memory_id: "confirmed-rule",
      class: "stable",
      evidence_strength: "user_asserted",
      state: "current_by_evidence",
    },
  );
  working.confirmation = [{ memory_id: "confirmed-rule", state: "confirmed" }];
  const repository = { available: true, dirty: false, headCommittedAt: 100 };
  const context = compactMemoryBootstrapContext(raw, "Jack", 4_096, undefined, repository);
  const packet = modelMemoryContext(context, 4_096, repository);
  for (const id of ["current-task", "confirmed-rule"]) {
    const item = packet.working_memory.items.find((entry) => entry.memory_id === id);
    assert.ok(item, id);
    assert.deepEqual(item.value, working.items.find((entry) => entry.memory_id === id)?.value);
  }
  assert.equal(
    packet.working_memory.confirmation.find((entry) => entry.memory_id === "confirmed-rule")?.state,
    "confirmed",
  );
  assert.ok(packet.bytes_used <= 4_096);
});

test("non-current multilingual previews keep exact wire bytes and aligned sidecars", () => {
  const raw = staleHandoffContext();
  const working = raw.structuredContent.working_memory as {
    items: Array<{ value: unknown; last_verified_at?: number }>;
    verification: Array<{ state: string }>;
  };
  for (const item of working.items) {
    item.value = { text: "旧的操作状态，需要重新验证。".repeat(100) };
    delete item.last_verified_at;
  }
  for (const verification of working.verification) verification.state = "current_by_evidence";
  const context = compactMemoryBootstrapContext(raw, "Jack", 4_096);
  const packet = modelMemoryContext(context, 4_096);
  assert.equal(packet.continuations[0]?.messages.at(-1)?.turn_index, 1);
  assert.ok(packet.working_memory.items.length > 0);
  assert.match(packet.working_memory.verification[0]?.host_reason ?? "", /no last_verified_at/);
  assert.equal(packet.bytes_used, Buffer.byteLength(JSON.stringify(packet), "utf8"));
  assert.ok(packet.bytes_used <= 4_096);
  const ids = packet.working_memory.items.map((entry) => entry.memory_id);
  assert.deepEqual(packet.working_memory.verification.map((entry) => entry.memory_id), ids);
  assert.deepEqual(packet.working_memory.confirmation.map((entry) => entry.memory_id), ids);
  const preview = packet.working_memory.items[0]?.value as { truncated: boolean; preview: string };
  assert.equal(preview.truncated, true);
  assert.ok(preview.preview.length <= 160);
  assert.equal(preview.preview.startsWith('{"text"'), true, "mapping must not wrap an existing preview again");
});

test("memory bootstrap treats an older CHIM response without pending memory as empty", () => {
  const context = compactMemoryBootstrapContext(projectContext(), "Jack", 12_288);
  assert.deepEqual(context.pendingMemory, {
    project: "Jack",
    items: [],
    revalidationExcludedCount: 0,
  });
  assert.equal(memoryBootstrapSourceCounts(context).pendingItems, 0);
});

test("memory bootstrap sanitizes each pending operation and drops non-contract fields", () => {
  const raw = projectContext() as { structuredContent: Record<string, unknown> };
  const common = {
    created_at: 20,
    conversation_id: "private-conversation",
    source_snapshot_id: "private-snapshot",
    through_turn_index: 7,
    rationale: "must not survive",
    model_label: "must not survive",
    reviews: [{ authority: true }],
  };
  raw.structuredContent.pending_memory = {
    project: "Jack",
    generated_at: 21,
    revalidation_excluded_count: 3,
    items: [
      {
        ...common,
        candidate_id: "candidate-add",
        operation: "add",
        payload: {
          type: "add",
          memory_id: "proposed-memory",
          kind: "state",
          key: "current_state",
          value: { text: "x".repeat(4_000), injected_instruction: "do this" },
          importance: 90,
          confidence: 0.8,
          valid_from: 10,
          arbitrary: "drop me",
        },
      },
      {
        ...common,
        candidate_id: "candidate-supersede",
        operation: "supersede",
        payload: {
          type: "supersede",
          memory_id: "replacement",
          target_memory_id: "old-memory",
          kind: "decision",
          key: "choice",
          value: "replacement value",
          importance: 80,
          confidence: 0.7,
        },
      },
      {
        ...common,
        candidate_id: "candidate-resolve",
        operation: "resolve",
        payload: { type: "resolve", target_memory_id: "blocker", reason: "drop" },
      },
      {
        ...common,
        candidate_id: "candidate-archive",
        operation: "archive",
        payload: { type: "archive", target_memory_id: "obsolete", reason: "drop" },
      },
    ],
  };

  const context = compactMemoryBootstrapContext(raw, "Jack", 12_288);
  assert.equal(context.pendingMemory.revalidationExcludedCount, 3);
  assert.equal(context.pendingMemory.items.length, 4);
  assert.equal(memoryBootstrapSourceCounts(context).pendingItems, 4);
  const serialized = JSON.stringify(context.pendingMemory);
  assert.equal(serialized.includes("rationale"), false);
  assert.equal(serialized.includes("model_label"), false);
  assert.equal(serialized.includes("reviews"), false);
  assert.equal(serialized.includes("arbitrary"), false);
  assert.equal(serialized.includes("reason"), false);
  const add = context.pendingMemory.items[0]!;
  assert.deepEqual(Object.keys(add).sort(), [
    "candidateId",
    "conversationId",
    "createdAt",
    "operation",
    "payload",
    "sourceSnapshotId",
    "throughTurnIndex",
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(add.payload), "utf8") < 1_200);
  assert.deepEqual(context.pendingMemory.items[2]?.payload, {
    type: "resolve",
    targetMemoryId: "blocker",
  });
});

test("pending memory has the smaller of a 3KB or 25 percent section budget", () => {
  assert.equal(memoryPendingByteBudget(4_096), 1_024);
  assert.equal(memoryPendingByteBudget(12_288), 3_072);
  assert.equal(memoryPendingByteBudget(40_000), 3_072);
});

test("memory bootstrap preserves recent continuation tails within a dedicated section budget", () => {
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
  assert.ok(
    Buffer.byteLength(JSON.stringify(context.continuations), "utf8")
      <= memoryContinuationByteBudget(4_096),
  );
  assert.equal(JSON.stringify(context).includes("sourceCounts"), false);
  assert.deepEqual(memoryBootstrapSourceCounts(context), {
    collaborationItems: 0,
    workingItems: 0,
    pendingItems: 0,
    continuationConversations: 2,
    continuationMessages: 11,
    relevantHits: 1,
    recentHits: 1,
  });
  assert.ok(context.continuations.length >= 1);
  assert.equal(context.continuations[0]?.conversationId, "continuation-1");
  assert.equal(context.continuations[0]?.messages.length, 3);
  if (context.continuations[1]) {
    assert.equal(context.continuations[1].conversationId, "continuation-2");
    assert.ok(context.continuations[1].messageOffset >= 10);
    if (context.continuations[1].messages.length > 0) {
      assert.equal(context.continuations[1].messages.at(-1)?.turnIndex, 17);
    }
  }
  assert.equal(context.truncated, true);
  assert.ok(memoryEvidenceIdsFromBootstrapContext(context).includes("continuation-1"));
});

test("memory bootstrap deduplicates recent hits already represented by continuations", () => {
  const raw = projectContext() as {
    structuredContent: Record<string, unknown>;
  };
  raw.structuredContent.continuations = [{
    conversation_id: "parent-1",
    source: "chatgpt",
    title: "Current project chat",
    message_offset: 0,
    total_messages: 2,
    messages: [
      { role: "user", turn_index: 0, text: "continue" },
      { role: "assistant", turn_index: 1, text: "next" },
    ],
  }];
  raw.structuredContent.relevant = [];
  raw.structuredContent.recent = [
    {
      result: {
        conversation_id: "parent-1",
        source: "chatgpt",
        title: "Duplicate continuation metadata",
        topic_tags: [],
      },
      evidence_conversation_id: "evidence-1",
    },
    {
      result: {
        conversation_id: "parent-2",
        source: "chatgpt",
        title: "Distinct recent project chat",
        topic_tags: [],
      },
      evidence_conversation_id: "evidence-2",
    },
    {
      result: {
        conversation_id: "parent-2",
        source: "chatgpt",
        title: "Duplicate recent hit",
        topic_tags: [],
      },
      evidence_conversation_id: "evidence-2",
    },
    {
      result: {
        conversation_id: "parent-3",
        source: "chatgpt",
        title: "Distinct parent backed by the continuation evidence thread",
        topic_tags: [],
      },
      evidence_conversation_id: "parent-1",
    },
  ];

  const context = compactMemoryBootstrapContext(raw, "Jack", 12_288);
  assert.deepEqual(
    context.recent.map((hit) => hit.conversationId),
    ["parent-2", "parent-3"],
  );
  assert.equal(context.truncated, false);
  assert.equal(memoryBootstrapSourceCounts(context).recentHits, 2);
  assert.deepEqual(
    memoryEvidenceIdsFromBootstrapContext(context).sort(),
    ["evidence-2", "parent-1", "parent-2", "parent-3"],
  );
});

test("memory bootstrap does not let raw continuation history consume an otherwise empty packet", () => {
  const raw = projectContext() as {
    structuredContent: Record<string, unknown>;
  };
  raw.structuredContent.continuations = [{
    conversation_id: "continuation-heavy",
    source: "chatgpt",
    title: "Long prior project conversation",
    update_time: 100,
    message_offset: 0,
    returned_messages: 8,
    total_messages: 8,
    messages: Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      create_time: 100 + index,
      turn_index: index,
      text: `message-${index}-${"x".repeat(2_400)}`,
    })),
  }];

  const context = compactMemoryBootstrapContext(raw, "Jack", 12_288);
  const continuationBytes = Buffer.byteLength(
    JSON.stringify(context.continuations),
    "utf8",
  );
  assert.ok(continuationBytes <= 4_096);
  assert.ok(continuationBytes <= memoryContinuationByteBudget(12_288));
  assert.equal(context.continuations.length, 1);
  assert.equal(context.continuations[0]?.messages.at(-1)?.turnIndex, 7);
  assert.ok((context.continuations[0]?.messageOffset ?? 0) > 0);
  assert.equal(context.truncated, true);
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
    verification: Array.from({ length: 8 }, (_, index) => ({
      memory_id: "memory-" + index,
      class: index === 0 ? "stable" : "operational",
      evidence_strength: "conversation_only",
      state: index === 0 ? "current_by_evidence" : "needs_revalidation",
      reason: index === 0 ? null : "newer project evidence exists",
      latest_project_evidence_at: 999,
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
  assert.equal(context.workingMemory.verification.length, context.workingMemory.items.length);
  assert.equal(context.workingMemory.verification[0]?.sourceState, "current_by_evidence");
  if (context.workingMemory.verification.length > 1) {
    assert.equal(
      context.workingMemory.verification[1]?.sourceState,
      "needs_revalidation",
    );
  }
  assert.ok(context.workingMemory.items.length < 8);
  assert.equal(context.continuations.length, 1);
  assert.ok(context.continuations[0]!.messages.length > 0);
  assert.equal(context.truncated, true);
  assert.equal(
    memoryEvidenceIdsFromBootstrapContext(context).includes("private-0"),
    false,
  );
});

test("memory bootstrap retains active working memory before pending proposals", () => {
  const raw = projectContext() as { structuredContent: Record<string, unknown> };
  raw.structuredContent.working_memory = {
    project: "Jack",
    items: [{
      memory_id: "active-state",
      kind: "state",
      key: "current_state",
      value: { text: "w".repeat(900) },
      importance: 100,
      confidence: 1,
      evidence: [],
    }],
  };
  raw.structuredContent.pending_memory = {
    project: "Jack",
    generated_at: 50,
    revalidation_excluded_count: 5,
    items: Array.from({ length: 8 }, (_, index) => ({
      candidate_id: `pending-${index}`,
      operation: "add",
      payload: {
        type: "add",
        memory_id: `proposed-${index}`,
        kind: "state",
        key: `proposal-${index}`,
        value: { text: "p".repeat(700) },
        importance: 50,
        confidence: 0.5,
      },
      created_at: 40 - index,
      conversation_id: `private-${index}`,
      source_snapshot_id: `snapshot-${index}`,
      through_turn_index: index,
    })),
  };

  const context = compactMemoryBootstrapContext(raw, "Jack", 4_096);
  assert.equal(context.workingMemory.items[0]?.memoryId, "active-state");
  assert.ok(context.pendingMemory.items.length < 8);
  assert.equal(context.pendingMemory.revalidationExcludedCount, 5);
  assert.ok(
    Buffer.byteLength(JSON.stringify(context.pendingMemory), "utf8")
      <= memoryPendingByteBudget(4_096),
  );
  assert.equal(context.truncated, true);
});

test("memory bootstrap synthesizes conservative verification for older CHIM responses", () => {
  const raw = projectContext() as {
    structuredContent: Record<string, unknown>;
  };
  raw.structuredContent.working_memory = {
    project: "Jack",
    items: [{
      memory_id: "legacy-operational",
      kind: "task",
      key: "next_action",
      value: { text: "finish acceptance" },
      importance: 90,
      confidence: 1,
      last_verified_at: 100,
      evidence: [{
        kind: "conversation_turn",
        reference: "conversation:legacy:message:a1",
      }],
    }],
  };

  const context = compactMemoryBootstrapContext(raw, "Jack", 4_096);
  assert.equal(context.workingMemory.verification.length, 1);
  assert.deepEqual(context.workingMemory.verification[0], {
    memoryId: "legacy-operational",
    class: "operational",
    evidenceStrength: "conversation_only",
    sourceState: "unavailable",
    sourceReason: "CHIM working-memory verification metadata was unavailable",
  });
  assert.deepEqual(context.workingMemory.confirmation[0], {
    memoryId: "legacy-operational",
    state: "not_applicable",
    reason: "memory kind is not governed by historical decision confirmation",
  });
});

test("older CHIM rule-like memory fails closed as requiring confirmation", () => {
  const raw = projectContext() as { structuredContent: Record<string, unknown> };
  raw.structuredContent.working_memory = {
    project: "Jack",
    items: [{
      memory_id: "legacy-decision",
      kind: "decision",
      key: "prompt_policy",
      value: { text: "Use the old prompt format." },
      importance: 100,
      confidence: 1,
      evidence: [{
        kind: "user_statement",
        reference: "conversation:legacy:message:u1",
      }],
    }],
  };

  const context = compactMemoryBootstrapContext(raw, "Jack", 4_096);
  assert.deepEqual(context.workingMemory.confirmation, [{
    memoryId: "legacy-decision",
    state: "requires_confirmation",
    reason: "CHIM confirmation metadata was unavailable; fail closed for rule-like memory",
  }]);
});

test("memory bootstrap preserves explicit CHIM project confirmation state", () => {
  const raw = projectContext() as { structuredContent: Record<string, unknown> };
  raw.structuredContent.working_memory = {
    project: "Jack",
    items: [{
      memory_id: "confirmed-decision",
      kind: "decision",
      key: "prompt_policy",
      value: { text: "Use the confirmed prompt format." },
      importance: 100,
      confidence: 1,
      evidence: [{
        kind: "user_statement",
        reference: "conversation:current:confirmation",
      }],
    }],
    confirmation: [{
      memory_id: "confirmed-decision",
      state: "confirmed",
      reason: "user confirmed this project rule through the operator confirmation path",
    }],
  };

  const context = compactMemoryBootstrapContext(raw, "Jack", 4_096);
  assert.deepEqual(context.workingMemory.confirmation, [{
    memoryId: "confirmed-decision",
    state: "confirmed",
    reason: "user confirmed this project rule through the operator confirmation path",
  }]);
});

test("memory bootstrap bounds collaboration memory ahead of project memory without authorizing provenance", () => {
  const raw = projectContext() as {
    structuredContent: Record<string, unknown>;
  };
  raw.structuredContent.collaboration_memory = {
    generated_at: 222,
    items: Array.from({ length: 6 }, (_, index) => ({
      memory_id: "collaboration-" + index,
      kind: index === 0 ? "invariant" : "preference",
      key: "collaboration-key-" + index,
      value: { text: "rule-" + index + "-" + "c".repeat(700) },
      importance: 100 - index,
      confidence: 1,
      evidence: [{
        kind: "conversation_turn",
        reference: "conversation:collaboration-private-" + index + ":turn:1",
      }],
    })),
  };
  raw.structuredContent.working_memory = {
    project: "Jack",
    items: [{
      memory_id: "project-goal",
      kind: "state",
      key: "current_goal",
      value: { text: "finish the current project" },
      importance: 100,
      confidence: 1,
      evidence: [],
    }],
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
  assert.ok(context.collaborationMemory.items.length > 0);
  assert.ok(context.collaborationMemory.items.length < 6);
  assert.equal(context.collaborationMemory.items[0]?.memoryId, "collaboration-0");
  assert.equal(context.workingMemory.items[0]?.memoryId, "project-goal");
  assert.equal(context.continuations[0]?.conversationId, "continuation-1");
  assert.equal(
    memoryEvidenceIdsFromBootstrapContext(context).some((id) =>
      id.startsWith("collaboration-private-")
    ),
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
  const raw = projectContext() as { structuredContent: Record<string, unknown> };
  raw.structuredContent.pending_memory = {
    project: "Jack",
    generated_at: 10,
    revalidation_excluded_count: 0,
    items: [{
      candidate_id: "pending-1",
      operation: "resolve",
      payload: { type: "resolve", target_memory_id: "target" },
      created_at: 9,
      conversation_id: "pending-private-conversation",
      source_snapshot_id: "pending-private-snapshot",
      through_turn_index: 4,
    }],
  };
  const context = compactMemoryBootstrapContext(raw, "Jack", 12_288);
  assert.deepEqual(
    memoryEvidenceIdsFromBootstrapContext(context).sort(),
    ["evidence-1", "parent-1"],
  );
  assert.equal(
    memoryEvidenceIdsFromBootstrapContext(context).includes("pending-private-conversation"),
    false,
  );
  assert.equal(
    memoryEvidenceIdsFromBootstrapContext(context).includes("pending-private-snapshot"),
    false,
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
  const raw = projectContext() as { structuredContent: Record<string, unknown> };
  raw.structuredContent.working_memory = {
    project: "Jack",
    items: [{
      memory_id: "current-state",
      kind: "state",
      key: "current_state",
      value: "active",
      importance: 90,
      confidence: 1,
      evidence: [],
    }],
  };
  const observedTools: string[] = [];
  let observedArgs: Record<string, unknown> | undefined;
  adapter.call = async (toolName, args) => {
    observedTools.push(toolName);
    observedArgs = args;
    return raw as CallToolResult;
  };

  const context = await adapter.bootstrapProjectContext("Jack");
  assert.deepEqual(observedTools, ["memory_project_context"]);
  assert.equal(observedArgs?.project, "Jack");
  assert.equal(observedArgs?.relevant_limit, 0);
  assert.equal(observedArgs?.recent_limit, 3);
  assert.equal(observedArgs?.continuation_message_limit, 8);
  assert.equal(observedArgs?.pending_limit, 8);
  assert.deepEqual(context.bootstrapStatus, {
    state: "not_required",
    activeWorkingMemoryItems: 1,
    estimatedModelAttempts: 0,
    selectedConversations: 0,
    skipReason: "active_working_memory_exists",
  });
});

test("empty working memory stays ChatGPT-first without requesting a model bootstrap plan", async () => {
  const adapter = new MemoryAdapter({
    enabled: true,
    command: "/bin/false",
    bootstrapTimeoutMs: 5_000,
    bootstrapByteBudget: 12_288,
  });
  const observedTools: string[] = [];
  adapter.call = async (toolName) => {
    observedTools.push(toolName);
    return projectContext();
  };

  const context = await adapter.bootstrapProjectContext("Jack");
  assert.deepEqual(observedTools, ["memory_project_context"]);
  assert.deepEqual(context.bootstrapStatus, {
    state: "not_required",
    activeWorkingMemoryItems: 0,
    estimatedModelAttempts: 0,
    selectedConversations: 0,
    skipReason: "chatgpt_first_no_model_bootstrap",
  });
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
