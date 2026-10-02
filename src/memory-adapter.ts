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

export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

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

export interface MemoryBootstrapWorkingMemory {
  project: string;
  generatedAt?: number;
  items: MemoryBootstrapWorkingItem[];
}

export interface MemoryBootstrapCollaborationMemory {
  generatedAt?: number;
  items: MemoryBootstrapWorkingItem[];
}

export interface MemoryBootstrapContext {
  project: string;
  sourcePolicy: string;
  collaborationMemory: MemoryBootstrapCollaborationMemory;
  workingMemory: MemoryBootstrapWorkingMemory;
  continuations: MemoryBootstrapContinuation[];
  relevant: MemoryBootstrapHit[];
  recent: MemoryBootstrapHit[];
  truncated: boolean;
  byteBudget: number;
}

export interface MemoryClient {
  readonly enabled: boolean;
  call(
    toolName: MemoryToolName,
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
    toolName: MemoryToolName,
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
    if (
      byteLength(context.workingMemory) > workingMemoryBudget
      || byteLength(context) > byteBudget
    ) {
      context.workingMemory.items.pop();
      context.truncated = true;
      break;
    }
  }
  context.truncated ||= context.workingMemory.items.length < workingMemoryCandidate.items.length;

  for (const candidate of continuationCandidates) {
    const continuation: MemoryBootstrapContinuation = {
      ...candidate,
      messages: [],
    };
    context.continuations.push(continuation);
    if (byteLength(context) > byteBudget) {
      context.continuations.pop();
      context.truncated = true;
      break;
    }
    for (const message of [...candidate.messages].reverse()) {
      continuation.messages.unshift(message);
      if (byteLength(context) > byteBudget) {
        continuation.messages.shift();
        context.truncated = true;
        break;
      }
    }
    const omitted = candidate.messages.length - continuation.messages.length;
    continuation.messageOffset += omitted;
    context.truncated ||= omitted > 0;
  }
  for (const group of ["relevant", "recent"] as const) {
    for (const hit of candidates[group]) {
      context[group].push(hit);
      if (byteLength(context) > byteBudget) {
        context[group].pop();
        context.truncated = true;
        break;
      }
    }
  }
  context.truncated ||=
    context.relevant.length < candidates.relevant.length ||
    context.recent.length < candidates.recent.length;
  if (byteLength(context) > byteBudget) {
    throw new Error("Memory bootstrap byte budget is too small for its envelope");
  }
  return context;
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
    return { project: expectedProject, items: [] };
  }
  if (working.project !== expectedProject || !Array.isArray(working.items)) {
    throw new Error("Malformed project working memory");
  }
  return {
    project: expectedProject,
    ...(typeof working.generated_at === "number" ? { generatedAt: working.generated_at } : {}),
    items: working.items.map(compactWorkingMemoryItem),
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
