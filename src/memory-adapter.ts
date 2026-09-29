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

export interface MemoryBootstrapContext {
  project: string;
  sourcePolicy: string;
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
      return CallToolResultSchema.parse(rawResult);
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
        relevant_limit: 4,
        recent_limit: 3,
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
  const context: MemoryBootstrapContext = {
    project: expectedProject,
    sourcePolicy: clip(structured.source_policy, 80),
    relevant: [],
    recent: [],
    truncated: false,
    byteBudget,
  };
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
