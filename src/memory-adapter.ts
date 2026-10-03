import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MemoryAdapterConfig } from "./config.js";

const MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_recent",
  "memory_get_thread",
  "memory_project_context",
] as const;

const MAX_CONTINUATION_BOOTSTRAP_BYTES = 4_096;
const MAX_PENDING_MEMORY_BOOTSTRAP_BYTES = 3_072;

export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];
export type MemoryAdapterToolName = MemoryToolName | "memory_health";

export interface MemoryBootstrapHit {
  conversationId: string;
  evidenceConversationId?: string;
  source: string;
  title: string;
  updateTime?: number;
  snippet?: string;
  topicTags: string[];
}

export interface MemoryBootstrapMessage {
  role: string;
  createTime?: number;
  turnIndex: number;
  text: string;
}

export interface MemoryBootstrapContinuation {
  conversationId: string;
  source: string;
  title: string;
  updateTime?: number;
  messageOffset: number;
  totalMessages: number;
  messages: MemoryBootstrapMessage[];
}

export interface MemoryBootstrapEvidence {
  kind: string;
  reference: string;
}

export interface MemoryBootstrapWorkingItem {
  memoryId: string;
  kind: string;
  key: string;
  value: unknown;
  importance: number;
  confidence: number;
  validFrom?: number;
  validUntil?: number;
  lastVerifiedAt?: number;
  evidence: MemoryBootstrapEvidence[];
}

export interface MemoryBootstrapWorkingVerification {
  memoryId: string;
  class: "stable" | "operational" | "tentative";
  evidenceStrength:
    | "strong_independent"
    | "user_asserted"
    | "conversation_only"
    | "none";
  sourceState:
    | "strongly_verified"
    | "current_by_evidence"
    | "needs_revalidation"
    | "tentative"
    | "expired"
    | "unavailable";
  sourceReason?: string;
  latestProjectEvidenceAt?: number;
}

export interface MemoryBootstrapWorkingMemory {
  project: string;
  generatedAt?: number;
  items: MemoryBootstrapWorkingItem[];
  verification: MemoryBootstrapWorkingVerification[];
}

export interface MemoryBootstrapCollaborationMemory {
  generatedAt?: number;
  items: MemoryBootstrapWorkingItem[];
}

export type MemoryBootstrapPendingOperation =
  | "add"
  | "supersede"
  | "resolve"
  | "archive";

export type MemoryBootstrapPendingPayload =
  | {
      type: "add";
      memoryId: string;
      kind: string;
      key: string;
      value: unknown;
      importance: number;
      confidence: number;
      validFrom?: number;
      validUntil?: number;
      lastVerifiedAt?: number;
    }
  | {
      type: "supersede";
      memoryId: string;
      targetMemoryId: string;
      kind: string;
      key: string;
      value: unknown;
      importance: number;
      confidence: number;
      validFrom?: number;
      validUntil?: number;
      lastVerifiedAt?: number;
    }
  | {
      type: "resolve";
      targetMemoryId: string;
    }
  | {
      type: "archive";
      targetMemoryId: string;
    };

export interface MemoryBootstrapPendingItem {
  candidateId: string;
  operation: MemoryBootstrapPendingOperation;
  payload: MemoryBootstrapPendingPayload;
  createdAt: number;
  conversationId: string;
  sourceSnapshotId: string;
  throughTurnIndex: number;
}

export interface MemoryBootstrapPendingMemory {
  project: string;
  generatedAt?: number;
  items: MemoryBootstrapPendingItem[];
  revalidationExcludedCount: number;
}

export interface MemoryBootstrapSourceCounts {
  collaborationItems: number;
  workingItems: number;
  pendingItems: number;
  continuationConversations: number;
  continuationMessages: number;
  relevantHits: number;
  recentHits: number;
}

export interface MemoryBootstrapContext {
  project: string;
  sourcePolicy: string;
  collaborationMemory: MemoryBootstrapCollaborationMemory;
  workingMemory: MemoryBootstrapWorkingMemory;
  pendingMemory: MemoryBootstrapPendingMemory;
  continuations: MemoryBootstrapContinuation[];
  relevant: MemoryBootstrapHit[];
  recent: MemoryBootstrapHit[];
  truncated: boolean;
  byteBudget: number;
}

const memoryBootstrapSourceCountsByContext = new WeakMap<
  MemoryBootstrapContext,
  MemoryBootstrapSourceCounts
>();

export function memoryBootstrapSourceCounts(
  context: MemoryBootstrapContext,
): MemoryBootstrapSourceCounts {
  return memoryBootstrapSourceCountsByContext.get(context) ?? {
    collaborationItems: context.collaborationMemory.items.length,
    workingItems: context.workingMemory.items.length,
    pendingItems: context.pendingMemory.items.length,
    continuationConversations: context.continuations.length,
    continuationMessages: context.continuations.reduce(
      (sum, continuation) => sum + continuation.messages.length,
      0,
    ),
    relevantHits: context.relevant.length,
    recentHits: context.recent.length,
  };
}

export function memoryContinuationByteBudget(byteBudget: number): number {
  return Math.min(
    MAX_CONTINUATION_BOOTSTRAP_BYTES,
    Math.floor(byteBudget * 0.35),
  );
}

export function memoryPendingByteBudget(byteBudget: number): number {
  return Math.min(
    MAX_PENDING_MEMORY_BOOTSTRAP_BYTES,
    Math.floor(byteBudget * 0.25),
  );
}

export interface MemoryClient {
  readonly enabled: boolean;
  call(
    toolName: MemoryAdapterToolName,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<CallToolResult>;
  bootstrapProjectContext(project: string): Promise<MemoryBootstrapContext>;
}

export class MemoryThreadAuthorizationStore {
  private readonly byProject = new Map<string, Set<string>>();

  constructor(
    private readonly maxPerProject = 512,
    private readonly maxProjects = 128,
  ) {}

  authorize(projectKey: string, ids: readonly string[]): void {
    let authorized = this.byProject.get(projectKey);
    if (!authorized) {
      authorized = new Set();
      this.byProject.set(projectKey, authorized);
      while (this.byProject.size > this.maxProjects) {
        const oldest = this.byProject.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.byProject.delete(oldest);
      }
    } else {
      this.byProject.delete(projectKey);
      this.byProject.set(projectKey, authorized);
    }
    for (const id of ids) {
      const normalized = id.trim();
      if (!normalized) continue;
      if (authorized.has(normalized)) authorized.delete(normalized);
      authorized.add(normalized);
      while (authorized.size > this.maxPerProject) {
        const oldest = authorized.values().next().value as string | undefined;
        if (!oldest) break;
        authorized.delete(oldest);
      }
    }
  }

  isAuthorized(projectKey: string, conversationId: string): boolean {
    return this.byProject.get(projectKey)?.has(conversationId) ?? false;
  }
}

export function memoryEvidenceIdsFromBootstrapContext(
  context: MemoryBootstrapContext,
): string[] {
  const ids: string[] = [];
  for (const continuation of context.continuations) ids.push(continuation.conversationId);
  for (const hit of [...context.relevant, ...context.recent]) {
    ids.push(hit.conversationId);
    if (hit.evidenceConversationId) ids.push(hit.evidenceConversationId);
  }
  return uniqueNonEmptyStrings(ids);
}

export function memoryEvidenceIdsFromSearchResult(raw: unknown): string[] {
  const result = record(raw);
  const structured = record(result?.structuredContent);
  if (!structured || !Array.isArray(structured.hits)) return [];

  const ids: string[] = [];
  for (const value of structured.hits) {
    const hit = record(value);
    const searchResult = record(hit?.result);
    if (typeof searchResult?.conversation_id === "string") {
      ids.push(searchResult.conversation_id);
    }
    if (typeof hit?.evidence_conversation_id === "string") {
      ids.push(hit.evidence_conversation_id);
    }
  }
  return uniqueNonEmptyStrings(ids);
}

export class MemoryAdapter {
  constructor(private readonly config: MemoryAdapterConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  async call(
    toolName: MemoryAdapterToolName,
    args: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ) {
    if (!this.config.enabled || !this.config.command) {
      throw new Error("DevSpace memory adapter is disabled");
    }
    const env: Record<string, string> = {
      RUST_LOG: "warn,rmcp=warn,reqwest=warn",
    };
    if (this.config.dataHome) {
      env.CHAT_HISTORY_DATA_HOME = this.config.dataHome;
    }
    const transport = new StdioClientTransport({
      command: this.config.command,
      env,
      stderr: "inherit",
    });
    const client = new Client({ name: "devspace-memory-adapter", version: "1.0.0" });
    try {
      await client.connect(
        transport,
        options.timeoutMs ? { timeout: options.timeoutMs } : undefined,
      );
      const rawResult = await client.callTool(
        { name: toolName, arguments: args },
        CallToolResultSchema,
        options.timeoutMs ? { timeout: options.timeoutMs } : undefined,
      );
      return compactMirroredMemoryResult(CallToolResultSchema.parse(rawResult));
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async bootstrapProjectContext(project: string): Promise<MemoryBootstrapContext> {
    const operation = this.call(
      "memory_project_context",
      {
        project,
        query: "current project state decisions blockers and recent implementation work",
        relevant_limit: 0,
        recent_limit: 3,
        continuation_message_limit: 8,
        pending_limit: 8,
      },
      { timeoutMs: this.config.bootstrapTimeoutMs },
    );
    const result = await withTimeout(
      operation,
      this.config.bootstrapTimeoutMs + 50,
      "Memory bootstrap timed out",
    );
    return compactMemoryBootstrapContext(result, project, this.config.bootstrapByteBudget);
  }
}

export function isMemoryToolName(value: string): value is MemoryToolName {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(value);
}

export function compactMemoryBootstrapContext(
  raw: unknown,
  expectedProject: string,
  byteBudget: number,
): MemoryBootstrapContext {
  const result = record(raw);
  const structured = record(result?.structuredContent);
  if (!structured || structured.project !== expectedProject || typeof structured.source_policy !== "string") {
    throw new Error("Malformed memory project context response");
  }
  if (!Array.isArray(structured.relevant) || !Array.isArray(structured.recent)) {
    throw new Error("Malformed memory project context response");
  }

  const candidates = {
    relevant: structured.relevant.map(compactHit),
    recent: structured.recent.map(compactHit),
  };
  const collaborationMemoryCandidate = compactCollaborationMemory(
    structured.collaboration_memory,
  );
  const workingMemoryCandidate = compactWorkingMemory(structured.working_memory, expectedProject);
  const pendingMemoryCandidate = compactPendingMemory(
    structured.pending_memory,
    expectedProject,
  );
  const continuationCandidates = Array.isArray(structured.continuations)
    ? structured.continuations.map(compactContinuation)
    : structured.continuation === undefined || structured.continuation === null
      ? []
      : [compactContinuation(structured.continuation)];
  const context: MemoryBootstrapContext = {
    project: expectedProject,
    sourcePolicy: clip(structured.source_policy, 80),
    collaborationMemory: {
      ...(collaborationMemoryCandidate.generatedAt === undefined
        ? {}
        : { generatedAt: collaborationMemoryCandidate.generatedAt }),
      items: [],
    },
    workingMemory: {
      project: expectedProject,
      ...(workingMemoryCandidate.generatedAt === undefined
        ? {}
        : { generatedAt: workingMemoryCandidate.generatedAt }),
      items: [],
      verification: [],
    },
    pendingMemory: {
      project: expectedProject,
      ...(pendingMemoryCandidate.generatedAt === undefined
        ? {}
        : { generatedAt: pendingMemoryCandidate.generatedAt }),
      items: [],
      revalidationExcludedCount: pendingMemoryCandidate.revalidationExcludedCount,
    },
    continuations: [],
    relevant: [],
    recent: [],
    truncated: false,
    byteBudget,
  };
  const collaborationMemoryBudget = Math.min(2_048, Math.floor(byteBudget * 0.2));
  for (const item of collaborationMemoryCandidate.items) {
    context.collaborationMemory.items.push(item);
    if (
      byteLength(context.collaborationMemory) > collaborationMemoryBudget
      || byteLength(context) > byteBudget
    ) {
      context.collaborationMemory.items.pop();
      context.truncated = true;
      break;
    }
  }
  context.truncated ||=
    context.collaborationMemory.items.length < collaborationMemoryCandidate.items.length;

  const workingMemoryBudget = Math.min(6_144, Math.floor(byteBudget * 0.55));
  for (const item of workingMemoryCandidate.items) {
    context.workingMemory.items.push(item);
    const verification = workingMemoryCandidate.verification.find(
      (candidate) => candidate.memoryId === item.memoryId,
    ) ?? fallbackWorkingMemoryVerification(item);
    context.workingMemory.verification.push(verification);
    if (
      byteLength(context.workingMemory) > workingMemoryBudget
      || byteLength(context) > byteBudget
    ) {
      context.workingMemory.items.pop();
      context.workingMemory.verification.pop();
      context.truncated = true;
      break;
    }
  }
  context.truncated ||= context.workingMemory.items.length < workingMemoryCandidate.items.length;

  const pendingMemoryBudget = memoryPendingByteBudget(byteBudget);
  for (const item of pendingMemoryCandidate.items) {
    context.pendingMemory.items.push(item);
    if (
      byteLength(context.pendingMemory) > pendingMemoryBudget
      || byteLength(context) > byteBudget
    ) {
      context.pendingMemory.items.pop();
      context.truncated = true;
      break;
    }
  }
  context.truncated ||= context.pendingMemory.items.length < pendingMemoryCandidate.items.length;

  const continuationBudget = memoryContinuationByteBudget(byteBudget);
  for (const candidate of continuationCandidates) {
    const continuation: MemoryBootstrapContinuation = {
      ...candidate,
      messages: [],
    };
    context.continuations.push(continuation);
    if (
      byteLength(context.continuations) > continuationBudget
      || byteLength(context) > byteBudget
    ) {
      context.continuations.pop();
      context.truncated = true;
      break;
    }
    for (const message of [...candidate.messages].reverse()) {
      continuation.messages.unshift(message);
      if (
        byteLength(context.continuations) > continuationBudget
        || byteLength(context) > byteBudget
      ) {
        continuation.messages.shift();
        context.truncated = true;
        break;
      }
    }
    const omitted = candidate.messages.length - continuation.messages.length;
    continuation.messageOffset += omitted;
    context.truncated ||= omitted > 0;
  }
  const continuationIds = new Set(
    context.continuations.map((continuation) => continuation.conversationId),
  );
  const dedupedHits = {
    relevant: dedupeBootstrapHits(candidates.relevant, continuationIds),
    recent: dedupeBootstrapHits(candidates.recent, continuationIds),
  };
  memoryBootstrapSourceCountsByContext.set(context, {
    collaborationItems: collaborationMemoryCandidate.items.length,
    workingItems: workingMemoryCandidate.items.length,
    pendingItems: pendingMemoryCandidate.items.length,
    continuationConversations: continuationCandidates.length,
    continuationMessages: continuationCandidates.reduce(
      (sum, continuation) => sum + continuation.messages.length,
      0,
    ),
    relevantHits: dedupedHits.relevant.length,
    recentHits: dedupedHits.recent.length,
  });
  for (const group of ["relevant", "recent"] as const) {
    for (const hit of dedupedHits[group]) {
      context[group].push(hit);
      if (byteLength(context) > byteBudget) {
        context[group].pop();
        context.truncated = true;
        break;
      }
    }
  }
  context.truncated ||=
    context.relevant.length < dedupedHits.relevant.length ||
    context.recent.length < dedupedHits.recent.length;
  if (byteLength(context) > byteBudget) {
    throw new Error("Memory bootstrap byte budget is too small for its envelope");
  }
  return context;
}

function dedupeBootstrapHits(
  hits: MemoryBootstrapHit[],
  excludedConversationIds: ReadonlySet<string>,
): MemoryBootstrapHit[] {
  const seen = new Set<string>();
  const output: MemoryBootstrapHit[] = [];
  for (const hit of hits) {
    if (excludedConversationIds.has(hit.conversationId)) {
      continue;
    }
    const key = hit.conversationId + "\u0000" + (hit.evidenceConversationId ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(hit);
  }
  return output;
}

export function compactMirroredMemoryResult(result: CallToolResult): CallToolResult {
  if (!result.structuredContent || result.content.length !== 1) return result;
  const only = result.content[0];
  if (only?.type !== "text") return result;
  try {
    const parsed = JSON.parse(only.text) as unknown;
    if (JSON.stringify(parsed) !== JSON.stringify(result.structuredContent)) return result;
  } catch {
    return result;
  }
  return {
    ...result,
    content: [],
  };
}

function compactContinuation(value: unknown): MemoryBootstrapContinuation {
  const continuation = record(value);
  if (
    !continuation
    || typeof continuation.conversation_id !== "string"
    || typeof continuation.source !== "string"
    || typeof continuation.title !== "string"
    || typeof continuation.message_offset !== "number"
    || typeof continuation.total_messages !== "number"
    || !Array.isArray(continuation.messages)
  ) {
    throw new Error("Malformed memory continuation");
  }
  return {
    conversationId: clip(continuation.conversation_id, 200),
    source: clip(continuation.source, 40),
    title: clip(continuation.title, 240),
    ...(typeof continuation.update_time === "number"
      ? { updateTime: continuation.update_time }
      : {}),
    messageOffset: continuation.message_offset,
    totalMessages: continuation.total_messages,
    messages: continuation.messages.map(compactMessage),
  };
}

function compactWorkingMemory(
  value: unknown,
  expectedProject: string,
): MemoryBootstrapWorkingMemory {
  const working = record(value);
  if (!working) {
    return { project: expectedProject, items: [], verification: [] };
  }
  if (working.project !== expectedProject || !Array.isArray(working.items)) {
    throw new Error("Malformed project working memory");
  }
  return {
    project: expectedProject,
    ...(typeof working.generated_at === "number" ? { generatedAt: working.generated_at } : {}),
    items: working.items.map(compactWorkingMemoryItem),
    verification: Array.isArray(working.verification)
      ? working.verification.map(compactWorkingMemoryVerification)
      : [],
  };
}

function compactCollaborationMemory(value: unknown): MemoryBootstrapCollaborationMemory {
  if (value === undefined || value === null) return { items: [] };
  const memory = record(value);
  if (!memory || !Array.isArray(memory.items)) {
    throw new Error("Malformed collaboration memory");
  }
  return {
    ...(typeof memory.generated_at === "number" ? { generatedAt: memory.generated_at } : {}),
    items: memory.items.map(compactWorkingMemoryItem),
  };
}

function compactPendingMemory(
  value: unknown,
  expectedProject: string,
): MemoryBootstrapPendingMemory {
  if (value === undefined || value === null) {
    return {
      project: expectedProject,
      items: [],
      revalidationExcludedCount: 0,
    };
  }
  const pending = record(value);
  if (
    !pending
    || pending.project !== expectedProject
    || !Array.isArray(pending.items)
    || !Number.isInteger(pending.revalidation_excluded_count)
    || (pending.revalidation_excluded_count as number) < 0
  ) {
    throw new Error("Malformed pending project memory");
  }
  return {
    project: expectedProject,
    ...(typeof pending.generated_at === "number"
      ? { generatedAt: pending.generated_at }
      : {}),
    items: pending.items.map(compactPendingMemoryItem),
    revalidationExcludedCount: pending.revalidation_excluded_count as number,
  };
}

function compactPendingMemoryItem(value: unknown): MemoryBootstrapPendingItem {
  const item = record(value);
  if (
    !item
    || typeof item.candidate_id !== "string"
    || !isPendingOperation(item.operation)
    || typeof item.created_at !== "number"
    || typeof item.conversation_id !== "string"
    || typeof item.source_snapshot_id !== "string"
    || !Number.isInteger(item.through_turn_index)
  ) {
    throw new Error("Malformed pending project memory item");
  }
  return {
    candidateId: clip(item.candidate_id, 200),
    operation: item.operation,
    payload: compactPendingMemoryPayload(item.payload, item.operation),
    createdAt: item.created_at,
    conversationId: clip(item.conversation_id, 200),
    sourceSnapshotId: clip(item.source_snapshot_id, 200),
    throughTurnIndex: item.through_turn_index as number,
  };
}

function compactPendingMemoryPayload(
  value: unknown,
  operation: MemoryBootstrapPendingOperation,
): MemoryBootstrapPendingPayload {
  const payload = record(value);
  if (!payload || payload.type !== operation) {
    throw new Error("Malformed pending project memory payload");
  }
  if (operation === "resolve" || operation === "archive") {
    if (typeof payload.target_memory_id !== "string") {
      throw new Error("Malformed pending project memory payload");
    }
    return {
      type: operation,
      targetMemoryId: clip(payload.target_memory_id, 200),
    };
  }
  if (
    typeof payload.memory_id !== "string"
    || typeof payload.kind !== "string"
    || typeof payload.key !== "string"
    || typeof payload.importance !== "number"
    || typeof payload.confidence !== "number"
    || (operation === "supersede" && typeof payload.target_memory_id !== "string")
  ) {
    throw new Error("Malformed pending project memory payload");
  }
  const common = {
    memoryId: clip(payload.memory_id, 200),
    kind: clip(payload.kind, 40),
    key: clip(payload.key, 160),
    value: compactPendingJsonValue(payload.value),
    importance: payload.importance,
    confidence: payload.confidence,
    ...(typeof payload.valid_from === "number" ? { validFrom: payload.valid_from } : {}),
    ...(typeof payload.valid_until === "number" ? { validUntil: payload.valid_until } : {}),
    ...(typeof payload.last_verified_at === "number"
      ? { lastVerifiedAt: payload.last_verified_at }
      : {}),
  };
  return operation === "supersede"
    ? {
        type: "supersede",
        ...common,
        targetMemoryId: clip(payload.target_memory_id as string, 200),
      }
    : { type: "add", ...common };
}

function compactPendingJsonValue(value: unknown): unknown {
  const compacted = compactJsonValue(value, 0);
  if (byteLength(compacted) <= 900) return compacted;
  return {
    truncated: true,
    preview: clip(JSON.stringify(compacted), 600),
  };
}

function isPendingOperation(value: unknown): value is MemoryBootstrapPendingOperation {
  return value === "add"
    || value === "supersede"
    || value === "resolve"
    || value === "archive";
}

function compactWorkingMemoryItem(value: unknown): MemoryBootstrapWorkingItem {
  const item = record(value);
  if (
    !item
    || typeof item.memory_id !== "string"
    || typeof item.kind !== "string"
    || typeof item.key !== "string"
    || typeof item.importance !== "number"
    || typeof item.confidence !== "number"
    || !Array.isArray(item.evidence)
  ) {
    throw new Error("Malformed project working memory item");
  }
  const compacted: MemoryBootstrapWorkingItem = {
    memoryId: clip(item.memory_id, 200),
    kind: clip(item.kind, 40),
    key: clip(item.key, 160),
    value: compactJsonValue(item.value, 0),
    importance: item.importance,
    confidence: item.confidence,
    ...(typeof item.valid_from === "number" ? { validFrom: item.valid_from } : {}),
    ...(typeof item.valid_until === "number" ? { validUntil: item.valid_until } : {}),
    ...(typeof item.last_verified_at === "number"
      ? { lastVerifiedAt: item.last_verified_at }
      : {}),
    evidence: item.evidence.slice(0, 6).map(compactWorkingMemoryEvidence),
  };
  if (byteLength(compacted) <= 2_600) return compacted;
  return {
    ...compacted,
    value: {
      truncated: true,
      preview: clip(JSON.stringify(compacted.value), 1_400),
    },
    evidence: compacted.evidence.slice(0, 3),
  };
}

function compactWorkingMemoryEvidence(value: unknown): MemoryBootstrapEvidence {
  const evidence = record(value);
  if (
    !evidence
    || typeof evidence.kind !== "string"
    || typeof evidence.reference !== "string"
  ) {
    throw new Error("Malformed project working memory evidence");
  }
  return {
    kind: clip(evidence.kind, 40),
    reference: clip(evidence.reference, 320),
  };
}

function compactWorkingMemoryVerification(
  value: unknown,
): MemoryBootstrapWorkingVerification {
  const verification = record(value);
  if (
    !verification
    || typeof verification.memory_id !== "string"
    || !isWorkingMemoryClass(verification.class)
    || !isWorkingMemoryEvidenceStrength(verification.evidence_strength)
    || !isWorkingMemorySourceState(verification.state)
  ) {
    throw new Error("Malformed project working memory verification");
  }
  return {
    memoryId: clip(verification.memory_id, 200),
    class: verification.class,
    evidenceStrength: verification.evidence_strength,
    sourceState: verification.state,
    ...(typeof verification.reason === "string"
      ? { sourceReason: clip(verification.reason, 600) }
      : {}),
    ...(typeof verification.latest_project_evidence_at === "number"
      ? { latestProjectEvidenceAt: verification.latest_project_evidence_at }
      : {}),
  };
}

function fallbackWorkingMemoryVerification(
  item: MemoryBootstrapWorkingItem,
): MemoryBootstrapWorkingVerification {
  const memoryClass = item.kind === "hypothesis"
    ? "tentative"
    : ["state", "blocker", "task"].includes(item.kind)
      ? "operational"
      : "stable";
  const evidenceKinds = new Set(item.evidence.map((evidence) => evidence.kind));
  const evidenceStrength = [
    "document",
    "git_commit",
    "repository_state",
    "devspace_result",
  ].some((kind) => evidenceKinds.has(kind))
    ? "strong_independent"
    : evidenceKinds.has("user_statement")
      ? "user_asserted"
      : evidenceKinds.has("conversation_turn")
        ? "conversation_only"
        : "none";
  return {
    memoryId: item.memoryId,
    class: memoryClass,
    evidenceStrength,
    sourceState: memoryClass === "tentative" ? "tentative" : "unavailable",
    sourceReason: "CHIM working-memory verification metadata was unavailable",
  };
}

function isWorkingMemoryClass(
  value: unknown,
): value is MemoryBootstrapWorkingVerification["class"] {
  return value === "stable" || value === "operational" || value === "tentative";
}

function isWorkingMemoryEvidenceStrength(
  value: unknown,
): value is MemoryBootstrapWorkingVerification["evidenceStrength"] {
  return value === "strong_independent"
    || value === "user_asserted"
    || value === "conversation_only"
    || value === "none";
}

function isWorkingMemorySourceState(
  value: unknown,
): value is MemoryBootstrapWorkingVerification["sourceState"] {
  return value === "strongly_verified"
    || value === "current_by_evidence"
    || value === "needs_revalidation"
    || value === "tentative"
    || value === "expired"
    || value === "unavailable";
}

function compactJsonValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return clip(value, 1_200);
  if (depth >= 4) return "[nested value omitted]";
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => compactJsonValue(item, depth + 1));
  }
  const object = record(value);
  if (!object) return String(value);
  return Object.fromEntries(
    Object.entries(object)
      .slice(0, 20)
      .map(([key, item]) => [clip(key, 120), compactJsonValue(item, depth + 1)]),
  );
}

function compactMessage(value: unknown): MemoryBootstrapMessage {
  const message = record(value);
  if (
    !message
    || typeof message.role !== "string"
    || typeof message.turn_index !== "number"
    || typeof message.text !== "string"
  ) {
    throw new Error("Malformed memory continuation message");
  }
  return {
    role: clip(message.role, 32),
    ...(typeof message.create_time === "number" ? { createTime: message.create_time } : {}),
    turnIndex: message.turn_index,
    text: clipContinuationMessage(message.text, 2_400),
  };
}

function compactHit(value: unknown): MemoryBootstrapHit {
  const hit = record(value);
  const result = record(hit?.result);
  if (
    !hit ||
    !result ||
    typeof result.conversation_id !== "string" ||
    typeof result.source !== "string" ||
    typeof result.title !== "string" ||
    !Array.isArray(result.topic_tags)
  ) {
    throw new Error("Malformed memory project context hit");
  }
  if (!result.topic_tags.every((tag) => typeof tag === "string")) {
    throw new Error("Malformed memory project context hit");
  }
  return {
    conversationId: clip(result.conversation_id, 200),
    ...(typeof hit.evidence_conversation_id === "string"
      ? { evidenceConversationId: clip(hit.evidence_conversation_id, 200) }
      : {}),
    source: clip(result.source, 40),
    title: clip(result.title, 240),
    ...(typeof result.update_time === "number" ? { updateTime: result.update_time } : {}),
    ...(typeof result.snippet === "string" ? { snippet: clip(result.snippet, 900) } : {}),
    topicTags: result.topic_tags.slice(0, 8).map((tag) => clip(tag, 64)),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function clip(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters - 1)}…`;
}

function clipContinuationMessage(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  const marker = "\n[… middle of this prior message omitted …]\n";
  const remaining = maxCharacters - marker.length;
  const head = Math.floor(remaining * 0.4);
  const tail = remaining - head;
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
