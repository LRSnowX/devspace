import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
} from "./logger.js";
import { readFileTool } from "./pi-tools.js";
import { FILE_REVISION_PATTERN } from "./file-revision.js";
import {
  ToolOperationError,
  toolErrorPayload,
  toolErrorPayloadSchema,
  type ToolErrorPayload,
} from "./tool-errors.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import {
  compileMcpRegistrationSurface,
  createModernMcpServerAdapter,
  modernMcpAdapterErrorLogFields,
  type McpRegistrationTarget,
} from "./mcp-modern-server.js";
import { ProcessSessionManager } from "./process-sessions.js";
import {
  MemoryAdapter,
  MemoryThreadAuthorizationStore,
  memoryBootstrapSourceCounts,
  memoryEvidenceIdsFromBootstrapContext,
  memoryEvidenceIdsFromSearchResult,
  type MemoryBootstrapContext,
  type MemoryClient,
} from "./memory-adapter.js";
import { ProjectRegistry } from "./project-registry.js";
import { PatchRecoveryManager, runPatchStartupRecovery } from "./patch-recovery.js";
import { expandHomePath } from "./roots.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { readRepositoryState } from "./repository-state.js";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { DEVSPACE_VERSION } from "./version.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
  workspaceAppDescriptorMeta,
} from "./tool-surfaces/shared.js";
import {
  WORKSPACE_APP_URI,
  toolNames,
  workspaceIdDescription,
  type ToolContent,
  type ToolSurface,
} from "./tool-surfaces/types.js";

const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";

function mcpServerInfo() {
  return {
    name: "devspace",
    title: "DevSpace",
    version: DEVSPACE_VERSION,
    description:
      "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspace_id.",
  };
}

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderStatus[];
  close(): Promise<void>;
}

type TrackToolActivity = <T>(operation: () => Promise<T>) => Promise<T>;

class ToolActivityTracker {
  private readonly active = new Set<Promise<unknown>>();

  readonly track: TrackToolActivity = <T>(operation: () => Promise<T>): Promise<T> => {
    const promise = operation();
    this.active.add(promise);
    const remove = () => this.active.delete(promise);
    void promise.then(remove, remove);
    return promise;
  };

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled(Array.from(this.active));
    }
  }
}

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

function serverInstructions(
  config: ServerConfig,
  toolSurface: ToolSurface,
): string {
  const artifactInstruction =
    config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
      ? " When the user provides an attached or generated file that needs to be added to the workspace, pass the provided file directly to download_artifact with the existing workspace_id and a suitable relative destination path. Do not reconstruct attached files manually."
      : "";
  const showChangesInstruction =
    " If files are modified, call show_changes once after the final related change and before the final response.";
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches one, use ${toolNames.read} with the returned skill path before proceeding. `
    : "";
  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in available_agents_files, use ${toolNames.read} to inspect that instruction file and follow it. `;
  const common = `Call ${toolNames.openWorkspace} when starting work in a project folder or isolated worktree without a usable workspace_id, then reuse the returned workspace_id for subsequent operations in that workspace.`;
  const projectMemory = " open_workspace also accepts an unambiguous project name or registered alias. When memory is configured it may return bounded memory_context containing durable project working memory plus recent conversation continuations. Treat live repository state and authoritative project files as stronger evidence than stored memory, then use working_memory as current durable project state and continuations as recent episodic context. Use memory_search for additional history questions and memory_get_thread only for discovered conversation evidence.";

  return `${common}${projectMemory} ${toolSurface.instructions({ agents, skills })}${artifactInstruction}${showChangesInstruction}`;
}

const memoryBootstrapHitOutputSchema = z.object({
  conversation_id: z.string(),
  evidence_conversation_id: z.string().optional(),
  source: z.string(),
  title: z.string(),
  update_time: z.number().optional(),
  snippet: z.string().optional(),
  topic_tags: z.array(z.string()),
});
const memoryBootstrapMessageOutputSchema = z.object({
  role: z.string(),
  create_time: z.number().optional(),
  turn_index: z.number(),
  text: z.string(),
});
const memoryBootstrapContinuationOutputSchema = z.object({
  conversation_id: z.string(),
  source: z.string(),
  title: z.string(),
  update_time: z.number().optional(),
  message_offset: z.number().int().nonnegative(),
  returned_messages: z.number().int().nonnegative(),
  total_messages: z.number().int().nonnegative(),
  messages: z.array(memoryBootstrapMessageOutputSchema),
});
const memoryBootstrapEvidenceOutputSchema = z.object({
  kind: z.string(),
  reference: z.string(),
});
const memoryBootstrapWorkingItemOutputSchema = z.object({
  memory_id: z.string(),
  kind: z.string(),
  key: z.string(),
  value: z.unknown(),
  importance: z.number(),
  confidence: z.number(),
  valid_from: z.number().optional(),
  valid_until: z.number().optional(),
  last_verified_at: z.number().optional(),
  evidence: z.array(memoryBootstrapEvidenceOutputSchema),
});
const memoryBootstrapWorkingVerificationOutputSchema = z.object({
  memory_id: z.string(),
  class: z.enum(["stable", "operational", "tentative"]),
  evidence_strength: z.enum([
    "strong_independent",
    "user_asserted",
    "conversation_only",
    "none",
  ]),
  source_state: z.enum([
    "strongly_verified",
    "current_by_evidence",
    "needs_revalidation",
    "tentative",
    "expired",
    "unavailable",
  ]),
  host_state: z.enum([
    "strongly_verified",
    "current_by_evidence",
    "needs_revalidation",
    "tentative",
    "expired",
  ]),
  source_reason: z.string().optional(),
  host_reason: z.string().optional(),
  latest_project_evidence_at: z.number().optional(),
  repository_head_committed_at: z.number().optional(),
});
const memoryBootstrapWorkingMemoryOutputSchema = z.object({
  project: z.string(),
  generated_at: z.number().optional(),
  items: z.array(memoryBootstrapWorkingItemOutputSchema),
  verification: z.array(memoryBootstrapWorkingVerificationOutputSchema),
});
const memoryBootstrapCollaborationMemoryOutputSchema = z.object({
  generated_at: z.number().optional(),
  items: z.array(memoryBootstrapWorkingItemOutputSchema),
});
const memoryBootstrapBudgetSectionOutputSchema = z.object({
  bytes: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative().optional(),
  truncated: z.boolean(),
});
const memoryBootstrapContextOutputSchema = z.object({
  project: z.string(),
  source_policy: z.string(),
  collaboration_memory: memoryBootstrapCollaborationMemoryOutputSchema,
  working_memory: memoryBootstrapWorkingMemoryOutputSchema,
  continuations: z.array(memoryBootstrapContinuationOutputSchema),
  relevant: z.array(memoryBootstrapHitOutputSchema),
  recent: z.array(memoryBootstrapHitOutputSchema),
  truncated: z.boolean(),
  byte_budget: z.number().int().positive(),
  bytes_used: z.number().int().nonnegative(),
  sections: z.object({
    collaboration_memory: memoryBootstrapBudgetSectionOutputSchema,
    working_memory: memoryBootstrapBudgetSectionOutputSchema,
    continuations: memoryBootstrapBudgetSectionOutputSchema,
    recent_hits: memoryBootstrapBudgetSectionOutputSchema,
  }),
});

export function modelMemoryContext(
  context: MemoryBootstrapContext,
  byteBudget: number,
  repositoryState?: Awaited<ReturnType<typeof readRepositoryState>>,
) {
  const mapHit = (hit: MemoryBootstrapContext["relevant"][number]) => ({
    conversation_id: hit.conversationId,
    evidence_conversation_id: hit.evidenceConversationId,
    source: hit.source,
    title: hit.title,
    update_time: hit.updateTime,
    snippet: hit.snippet,
    topic_tags: hit.topicTags,
  });
  const mapMemoryItem = (item: MemoryBootstrapContext["workingMemory"]["items"][number]) => ({
    memory_id: item.memoryId,
    kind: item.kind,
    key: item.key,
    value: item.value,
    importance: item.importance,
    confidence: item.confidence,
    valid_from: item.validFrom,
    valid_until: item.validUntil,
    last_verified_at: item.lastVerifiedAt,
    evidence: item.evidence.map((evidence) => ({
      kind: evidence.kind,
      reference: evidence.reference,
    })),
  });
  const mapWorkingVerification = (
    verification: MemoryBootstrapContext["workingMemory"]["verification"][number],
  ) => {
    const item = context.workingMemory.items.find(
      (candidate) => candidate.memoryId === verification.memoryId,
    );
    const repositoryHeadCommittedAt = repositoryState?.available
      ? repositoryState.headCommittedAt
      : undefined;
    const repositoryDirty = repositoryState?.available && repositoryState.dirty === true;
    let hostState = verification.sourceState === "unavailable"
      ? verification.class === "tentative"
        ? "tentative"
        : verification.class === "operational"
          ? "needs_revalidation"
          : verification.evidenceStrength === "strong_independent"
            ? "strongly_verified"
            : "current_by_evidence"
      : verification.sourceState;
    let hostReason = verification.sourceReason
      ?? (verification.sourceState === "unavailable" && verification.class === "operational"
        ? "CHIM working-memory verification metadata is unavailable for this operational memory; verify it against live project state before acting."
        : undefined);

    if (
      verification.class === "operational"
      && hostState !== "expired"
      && hostState !== "tentative"
      && hostState !== "needs_revalidation"
    ) {
      if (repositoryDirty) {
        hostState = "needs_revalidation";
        hostReason =
          "Live repository working tree has uncommitted changes, so this operational memory cannot be safely treated as current without checking the changed files.";
      } else if (item?.lastVerifiedAt === undefined) {
        hostState = "needs_revalidation";
        hostReason =
          "Operational memory has no last_verified_at timestamp; verify it against live repository state before treating it as current.";
      } else if (
        repositoryHeadCommittedAt !== undefined
        && repositoryHeadCommittedAt > item.lastVerifiedAt
      ) {
        hostState = "needs_revalidation";
        hostReason =
          "Live repository HEAD is newer than this operational memory's last verification; verify it against current repository state before acting.";
      }
    }

    return {
      memory_id: verification.memoryId,
      class: verification.class,
      evidence_strength: verification.evidenceStrength,
      source_state: verification.sourceState,
      host_state: hostState,
      source_reason: verification.sourceReason,
      host_reason: hostReason,
      latest_project_evidence_at: verification.latestProjectEvidenceAt,
      repository_head_committed_at: repositoryHeadCommittedAt,
    };
  };
  const output = {
    project: context.project,
    source_policy: context.sourcePolicy,
    collaboration_memory: {
      generated_at: context.collaborationMemory.generatedAt,
      items: context.collaborationMemory.items.map(mapMemoryItem),
    },
    working_memory: {
      project: context.workingMemory.project,
      generated_at: context.workingMemory.generatedAt,
      items: context.workingMemory.items.map(mapMemoryItem),
      verification: context.workingMemory.verification.map(mapWorkingVerification),
    },
    continuations: context.continuations.map((continuation) => ({
          conversation_id: continuation.conversationId,
          source: continuation.source,
          title: continuation.title,
          update_time: continuation.updateTime,
          message_offset: continuation.messageOffset,
          returned_messages: continuation.messages.length,
          total_messages: continuation.totalMessages,
          messages: continuation.messages.map((message) => ({
            role: message.role,
            create_time: message.createTime,
            turn_index: message.turnIndex,
            text: message.text,
          })),
        })),
    relevant: context.relevant.map(mapHit),
    recent: context.recent.map(mapHit),
    truncated: context.truncated,
    byte_budget: byteBudget,
    bytes_used: 0,
    sections: {
      collaboration_memory: { bytes: 0, items: 0, truncated: false },
      working_memory: { bytes: 0, items: 0, truncated: false },
      continuations: { bytes: 0, items: 0, messages: 0, truncated: false },
      recent_hits: { bytes: 0, items: 0, truncated: false },
    },
  };
  const sourceCounts = memoryBootstrapSourceCounts(context);
  const refreshBudgetTelemetry = () => {
    const continuationMessages = output.continuations.reduce(
      (sum, continuation) => sum + continuation.messages.length,
      0,
    );
    output.sections = {
      collaboration_memory: {
        bytes: Buffer.byteLength(JSON.stringify(output.collaboration_memory), "utf8"),
        items: output.collaboration_memory.items.length,
        truncated: output.collaboration_memory.items.length < sourceCounts.collaborationItems,
      },
      working_memory: {
        bytes: Buffer.byteLength(JSON.stringify(output.working_memory), "utf8"),
        items: output.working_memory.items.length,
        truncated: output.working_memory.items.length < sourceCounts.workingItems,
      },
      continuations: {
        bytes: Buffer.byteLength(JSON.stringify(output.continuations), "utf8"),
        items: output.continuations.length,
        messages: continuationMessages,
        truncated:
          output.continuations.length < sourceCounts.continuationConversations
          || continuationMessages < sourceCounts.continuationMessages,
      },
      recent_hits: {
        bytes: Buffer.byteLength(
          JSON.stringify({ relevant: output.relevant, recent: output.recent }),
          "utf8",
        ),
        items: output.relevant.length + output.recent.length,
        truncated:
          output.relevant.length + output.recent.length
          < sourceCounts.relevantHits + sourceCounts.recentHits,
      },
    };
    let previous = -1;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const bytes = Buffer.byteLength(JSON.stringify(output), "utf8");
      output.bytes_used = bytes;
      if (bytes === previous) break;
      previous = bytes;
    }
  };
  refreshBudgetTelemetry();
  while (output.bytes_used > byteBudget) {
    if (output.recent.length > 0) output.recent.pop();
    else if (output.relevant.length > 0) output.relevant.pop();
    else {
      const continuation = [...output.continuations]
        .reverse()
        .find((candidate) => candidate.messages.length > 0);
      if (continuation) {
        continuation.messages.shift();
        continuation.message_offset += 1;
        continuation.returned_messages = continuation.messages.length;
      } else if (output.continuations.length > 0) {
        output.continuations.pop();
      } else if (output.working_memory.items.length > 0) {
        const removed = output.working_memory.items.pop();
        if (removed) {
          const index = output.working_memory.verification.findIndex(
            (verification) => verification.memory_id === removed.memory_id,
          );
          if (index >= 0) output.working_memory.verification.splice(index, 1);
        }
      } else if (output.collaboration_memory.items.length > 0) {
        output.collaboration_memory.items.pop();
      } else {
        throw new Error("Memory bootstrap byte budget is too small for its envelope");
      }
    }
    output.truncated = true;
    refreshBudgetTelemetry();
  }
  refreshBudgetTelemetry();
  return output;
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const effort = agent.effort ? `, effort ${agent.effort}` : "";
  return `${agent.name} (${agent.provider}${model}${effort})`;
}

function formatAvailableAgentProvider(provider: {
  id: string;
  model?: string;
  effort?: string;
  note?: string;
}): string {
  const details = [
    provider.model ? `model ${provider.model}` : undefined,
    provider.effort ? `effort ${provider.effort}` : undefined,
    provider.note,
  ].filter(Boolean).join(", ");
  return `${provider.id}${details ? ` (${details})` : ""}`;
}

function toolErrorResponse(payload: ToolErrorPayload) {
  const content = [textBlock(payload.message)];
  return {
    content,
    structuredContent: {
      result: payload.message,
      status: "error" as const,
      error: payload,
    },
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean().optional(),
  original_bytes: z.number().int().positive().optional(),
});

const repositoryChangeOutputSchema = z.object({
  status: z.string(),
  path: z.string(),
});

const repositoryStateOutputSchema = z.object({
  available: z.boolean(),
  reason: z.enum(["not_git", "unborn_head", "git_error"]).optional(),
  git_root: z.string().optional(),
  branch: z.string().optional(),
  head: z.string().optional(),
  head_committed_at: z.number().int().nonnegative().optional(),
  detached: z.boolean().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  dirty: z.boolean().optional(),
  modified: z.number().int().nonnegative().optional(),
  deleted: z.number().int().nonnegative().optional(),
  renamed: z.number().int().nonnegative().optional(),
  untracked: z.number().int().nonnegative().optional(),
  conflicted: z.number().int().nonnegative().optional(),
  changes: z.array(repositoryChangeOutputSchema).optional(),
  changes_truncated: z.boolean().optional(),
});

const authoritativeReferenceOutputSchema = z.object({
  path: z.string(),
  kind: z.enum(["project_instructions", "nested_instructions"]),
  loaded: z.boolean(),
  truncated: z.boolean().optional(),
});

export function modelRepositoryState(state: Awaited<ReturnType<typeof readRepositoryState>>) {
  return {
    available: state.available,
    reason: state.reason,
    git_root: state.gitRoot,
    branch: state.branch,
    head: state.head,
    head_committed_at: state.headCommittedAt,
    detached: state.detached,
    upstream: state.upstream,
    ahead: state.ahead,
    behind: state.behind,
    dirty: state.dirty,
    modified: state.modified,
    deleted: state.deleted,
    renamed: state.renamed,
    untracked: state.untracked,
    conflicted: state.conflicted,
    changes: state.changes,
    changes_truncated: state.changesTruncated,
  };
}

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const MODEL_INSTRUCTION_FILE_MAX_BYTES = 48 * 1024;
const MODEL_INSTRUCTION_FILE_HEAD_BYTES = 34 * 1024;
const MODEL_INSTRUCTION_FILE_TAIL_BYTES = 12 * 1024;

function compactInstructionFileForModel(content: string) {
  const originalBytes = Buffer.byteLength(content, "utf8");
  if (originalBytes <= MODEL_INSTRUCTION_FILE_MAX_BYTES) {
    return { content };
  }
  const head = utf8Prefix(content, MODEL_INSTRUCTION_FILE_HEAD_BYTES);
  const tail = utf8Suffix(content, MODEL_INSTRUCTION_FILE_TAIL_BYTES);
  const omittedBytes = Math.max(
    0,
    originalBytes
      - Buffer.byteLength(head, "utf8")
      - Buffer.byteLength(tail, "utf8"),
  );
  return {
    content: [
      head,
      "",
      "[... DevSpace omitted " + omittedBytes + " bytes from the middle of this oversized instruction file. Read the file by range if an omitted section is relevant. ...]",
      "",
      tail,
    ].join("\n"),
    truncated: true as const,
    original_bytes: originalBytes,
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function utf8Suffix(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  trackToolActivity?: TrackToolActivity,
  memoryClient?: MemoryClient,
  memoryThreadAuthorizations = new MemoryThreadAuthorizationStore(),
  patchRecovery?: PatchRecoveryManager,
): McpServer {
  const toolSurface = getToolSurface(config.toolMode);
  const server = new McpServer(
    mcpServerInfo(),
    {
      instructions: serverInstructions(config, toolSurface),
    },
  );

  registerMcpSurface(
    server,
    config,
    workspaces,
    reviewCheckpoints,
    processSessions,
    resolveLocalAgentProviders,
    incomingArtifactAdapters,
    trackToolActivity,
    memoryClient,
    memoryThreadAuthorizations,
    patchRecovery,
  );
  return server;
}

function registerMcpSurface(
  server: McpRegistrationTarget,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  trackToolActivity?: TrackToolActivity,
  memoryClient?: MemoryClient,
  memoryThreadAuthorizations = new MemoryThreadAuthorizationStore(),
  patchRecovery?: PatchRecoveryManager,
): void {
  const registrationTarget = trackToolActivity
    ? withTrackedToolHandlers(server, trackToolActivity)
    : server;
  const toolSurface = getToolSurface(config.toolMode);
  const memory = memoryClient ?? new MemoryAdapter(config.memory);
  const projects = new ProjectRegistry(config.projectRegistryPath, config.allowedRoots);
  const memoryProjectForWorkspace = async (workspaceId: string) => {
    const workspace = await workspaces.getWorkspace(workspaceId);
    const path = workspace.sourceRoot ?? workspace.root;
    return {
      project: projects.projectNameForPath(path) ?? basename(path),
      authorizationKey: path,
    };
  };

  registerAppResource(
    registrationTarget,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    registrationTarget,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Start work in a project directory or isolated worktree when no usable workspace_id exists for it. Accepts an absolute or ~/ path, registered project name or alias, or unique top-level directory name in an allowed root. Reuse the existing workspace_id during continued work. Defaults to the actual checkout; set mode=\"worktree\" for isolated work.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute or ~/ path, canonical project name, registered alias, or unique top-level directory name under an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work.",
          ),
        base_ref: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        status: z.enum(["opened", "error"]),
        workspace_id: z.string().optional(),
        root: z.string().optional(),
        mode: z.enum(["checkout", "worktree"]).optional(),
        source_root: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            base_ref: z.string(),
            base_sha: z.string(),
            dirty_source: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agents_files: z.array(workspaceAgentsFileOutputSchema).optional(),
        available_agents_files: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agent_providers: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skill_diagnostics: z.array(z.unknown()).optional(),
        project_name: z.string().optional(),
        repository_state: repositoryStateOutputSchema.optional(),
        authoritative_references: z.array(authoritativeReferenceOutputSchema).optional(),
        memory_context: memoryBootstrapContextOutputSchema.optional(),
        review: z.discriminatedUnion("available", [
          z.object({ available: z.literal(true) }),
          z.object({
            available: z.literal(false),
            reason: z.string(),
          }),
        ]).optional(),
        instruction: z.string().optional(),
        result: z.string().optional(),
        error: toolErrorPayloadSchema.optional(),
      },
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, base_ref }, { _meta }) => {
      const startedAt = performance.now();
      const baseRef = base_ref;
      let resolvedPath = path;
      let projectName: string;
      let workspaceContext;
      try {
        if (isAbsolute(path) || path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
          resolvedPath = expandHomePath(path);
          projectName = projects.projectNameForPath(path) ?? basename(path);
        } else {
          const lookup = projects.lookup(path);
          if (lookup.status === "unknown") {
            throw new ToolOperationError({
              code: "PROJECT_NOT_FOUND",
              category: "not_found",
              message: `Unknown project '${path}'. Pass an absolute path inside an allowed root or register it with devspace projects register.`,
              retryable: false,
              path,
            });
          }
          if (lookup.status === "ambiguous") {
            throw new ToolOperationError({
              code: "PROJECT_AMBIGUOUS",
              category: "invalid_request",
              message: `Project '${path}' is ambiguous across allowed roots: ${lookup.paths.join(", ")}. Pass an absolute path or register it.`,
              retryable: false,
              path,
              candidate_paths: lookup.paths,
            });
          }
          resolvedPath = lookup.resolution.project.path;
          projectName = lookup.resolution.project.name;
        }
        workspaceContext = await workspaces.openWorkspace(
          { path: resolvedPath, mode, baseRef },
          { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) },
        );
      } catch (error) {
        const payload = toolErrorPayload(error);
        if (!payload) throw error;
        const result = toolErrorResponse(payload);
        logFailedToolResponse(config, {
          tool: "open_workspace",
          path,
        }, result.content, startedAt);
        return result;
      }
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = workspaceContext;
      const [review, repositoryState] = await Promise.all([
        reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        }),
        readRepositoryState(workspace.root),
      ]);
      const preloadSubagents = config.subagents.enabled
        && config.subagents.instructions === "preload";
      const subagentsSkill = workspace.skills.find((skill) => skill.name === "subagents");
      const preloadedSubagentInstructions = preloadSubagents && subagentsSkill
        ? readFileSync(subagentsSkill.filePath, "utf8")
        : undefined;
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .filter((skill) => !(preloadSubagents && skill.name === "subagents"))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const agentCatalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const cardAgentProviders = agentCatalog.providers
        .filter((provider) => provider.usable)
        .map((provider) => ({
          id: provider.id,
          model: provider.model,
          effort: provider.effort,
          note: provider.note,
        }));
      const cardAgents = agentCatalog.profiles;
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        ...compactInstructionFileForModel(file.content),
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const loadedReferencePaths = new Set(cardAgentsFiles.map((file) => file.path));
      const authoritativeReferences = [
        ...cardAgentsFiles.map((file) => ({
          path: file.path,
          kind: "project_instructions" as const,
          loaded: true,
          ...(file.truncated ? { truncated: true } : {}),
        })),
        ...cardAvailableAgentsFiles
          .filter((file) => !loadedReferencePaths.has(file.path))
          .map((file) => ({
            path: file.path,
            kind: "nested_instructions" as const,
            loaded: false,
          })),
      ];
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const truncatedAgentsFiles = loadedAgentsFiles.filter((file) => file.truncated);
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      let memoryContext: ReturnType<typeof modelMemoryContext> | undefined;
      if (memory.enabled && includeBootstrapContext) {
        try {
          const compact = await memory.bootstrapProjectContext(projectName);
          const candidate = modelMemoryContext(
            compact,
            config.memory.bootstrapByteBudget,
            repositoryState,
          );
          memoryContext = candidate;
          memoryThreadAuthorizations.authorize(
            workspace.sourceRoot ?? workspace.root,
            memoryEvidenceIdsFromBootstrapContext(compact),
          );
        } catch (error) {
          logEvent(config.logging, "warn", "memory_bootstrap_failed", {
            project: projectName,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const memoryLayers = memoryContext
        ? [
            memoryContext.collaboration_memory.items.length
              ? "structuredContent.memory_context.collaboration_memory as stable cross-project collaboration rules"
              : undefined,
            memoryContext.working_memory.items.length
              ? "structuredContent.memory_context.working_memory as the current durable project state"
              : undefined,
            memoryContext.continuations.length
              ? "structuredContent.memory_context.continuations as recent prior-conversation context"
              : undefined,
          ].filter((value): value is string => Boolean(value))
        : [];
      const memoryInstruction = memoryContext
        ? memoryLayers.length > 0
          ? `Treat ${memoryLayers.join(", ")}. Continue from these memory layers without waiting for the user to request a memory lookup. Live repository state and authoritative project files outrank stored memory when they conflict; use memory_search only when additional history is needed.`
          : "Use structuredContent.memory_context as bounded prior project context; use memory_search when additional history is needed."
        : undefined;
      const cardInstruction = [
        config.skillsEnabled
          ? "Use this workspace_id for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agents_files instructions. Before working under a path listed in available_agents_files, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
          : "Use this workspace_id for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agents_files instructions. Before working under a path listed in available_agents_files, read that instruction file.",
        "Treat structuredContent.repository_state as the live repository snapshot for this workspace. Treat structuredContent.authoritative_references as the explicit project-instruction sources. These live/authoritative sources outrank stored memory when they conflict.",
        memoryInstruction,
        truncatedAgentsFiles.length > 0
          ? "Some oversized instruction files were context-bounded to their beginning and latest tail. Treat the visible content as authoritative for those portions and use read on the returned path when an omitted middle section is relevant."
          : undefined,
      ].filter(Boolean).join(" ");
      const workspaceInstruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspace_id.",
            "structuredContent.repository_state is refreshed for this call; treat it as the current repository reality.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspace_id for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
          : cardInstruction;
      const instruction = preloadedSubagentInstructions && includeBootstrapContext
        ? [
            workspaceInstruction,
            "Subagent workflow instructions:",
            preloadedSubagentInstructions,
          ].join("\n\n")
        : workspaceInstruction;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            truncatedAgentsFiles.length > 0
              ? `Context-bounded oversized instructions: ${truncatedAgentsFiles.map((file) => `${file.path} (${file.original_bytes} bytes)`).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.length > 0
              ? `Available subagent providers: ${visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            repositoryState.available
              ? `Repository state: ${repositoryState.branch ?? "(detached)"} @ ${repositoryState.head?.slice(0, 12) ?? "unknown"}; dirty=${repositoryState.dirty ?? false}.`
              : `Repository state unavailable: ${repositoryState.reason ?? "unknown"}.`,
            authoritativeReferences.length > 0
              ? `Authoritative project references: ${authoritativeReferences.map((reference) => reference.path).join(", ")}`
              : undefined,
            memoryContext?.collaboration_memory.items.length
              ? "Stable Collaboration Memory is available in structuredContent.memory_context.collaboration_memory."
              : undefined,
            memoryContext?.working_memory.items.length
              ? "Durable Project Working Memory is available in structuredContent.memory_context.working_memory."
              : undefined,
            memoryContext?.continuations.length
              ? "Recent project conversation continuity is available in structuredContent.memory_context.continuations."
              : memoryContext
                ? "Bounded project memory context is available in structuredContent.memory_context."
                : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            availableAgentsFiles: cardAvailableAgentsFiles,
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            review,
            instruction: cardInstruction,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          status: "opened" as const,
          workspace_id: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          project_name: projectName,
          repository_state: modelRepositoryState(repositoryState),
          authoritative_references: authoritativeReferences,
          memory_context: memoryContext,
          source_root: workspace.sourceRoot,
          worktree: workspace.worktree
            ? {
                path: workspace.worktree.path,
                base_ref: workspace.worktree.baseRef,
                base_sha: workspace.worktree.baseSha,
                dirty_source: workspace.worktree.dirtySource,
                detached: workspace.worktree.detached,
                managed: workspace.worktree.managed,
              }
            : undefined,
          review,
          ...(includeBootstrapContext
            ? {
                agents_files: loadedAgentsFiles,
                available_agents_files: availableAgentsFileOutputs,
                skills: visibleSkills,
                agent_providers: visibleAgentProviders,
                agents: visibleAgents,
                skill_diagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
        },
      };
    },
  );

  if (memory.enabled) {
    registrationTarget.registerTool(
      "memory_search",
      {
        title: "Search project memory",
        description: "Search long-term project memory. Returns bounded durable Working Memory first and deeper conversation evidence second. Results are a relevance filter, not a project security boundary. Use memory_get_thread only to expand returned conversation/evidence hits.",
        inputSchema: {
          workspace_id: z.string().describe(workspaceIdDescription),
          query: z.string().trim().min(1),
          limit: z.number().int().positive().max(20).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ workspace_id, query, limit }) => {
        let memoryWorkspace;
        try {
          memoryWorkspace = await memoryProjectForWorkspace(workspace_id);
        } catch (error) {
          const payload = toolErrorPayload(error);
          if (!payload) throw error;
          return toolErrorResponse(payload);
        }
        const { project, authorizationKey } = memoryWorkspace;
        const result = await memory.call("memory_search", { project, query, limit });
        memoryThreadAuthorizations.authorize(
          authorizationKey,
          memoryEvidenceIdsFromSearchResult(result),
        );
        return result;
      },
    );
    registrationTarget.registerTool(
      "memory_get_thread",
      {
        title: "Read discovered memory thread",
        description: "Expand a conversation or evidence ID previously returned for this project by open_workspace or memory_search. Without message_offset, returns the latest messages; use message_offset for explicit older pagination. Authorization is process-local and expires on server restart.",
        inputSchema: {
          workspace_id: z.string().describe(workspaceIdDescription),
          conversation_id: z.string().trim().min(1),
          message_offset: z.number().int().nonnegative().optional(),
          message_limit: z.number().int().positive().max(16).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ workspace_id, conversation_id, message_offset, message_limit }) => {
        let memoryWorkspace;
        try {
          memoryWorkspace = await memoryProjectForWorkspace(workspace_id);
        } catch (error) {
          const payload = toolErrorPayload(error);
          if (!payload) throw error;
          return toolErrorResponse(payload);
        }
        const { authorizationKey } = memoryWorkspace;
        if (!memoryThreadAuthorizations.isAuthorized(authorizationKey, conversation_id)) {
          return toolErrorResponse({
            code: "MEMORY_THREAD_NOT_AUTHORIZED",
            category: "scope",
            message:
              `Memory thread is not authorized for this project: ${conversation_id}. Run memory_search for this project and retry only with a returned conversation/evidence ID.`,
            retryable: true,
            conversation_id,
          });
        }
        return memory.call("memory_get_thread", {
          conversation_id,
          message_offset,
          message_limit: message_limit ?? 8,
          ...(message_offset === undefined ? { tail: true } : {}),
        });
      },
    );
  }

  registrationTarget.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read all or part of a file in a workspace.",
          "Successful reads return a revision for the complete file; pass it to apply_patch expected_revisions when a patch relies on this read.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read the returned skill path before proceeding."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspace_id: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path relative to the workspace root, or a skill path returned by open_workspace."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema({
        status: z.enum(["read", "error"]),
        revision: z
          .string()
          .regex(FILE_REVISION_PATTERN)
          .optional()
          .describe("SHA-256 revision of the complete file bytes read."),
        error: toolErrorPayloadSchema.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, ...input }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      let response;
      try {
        const workspace = await workspaces.getWorkspace(workspaceId);
        const readPath = await workspaces.resolveReadPath(workspace, input.path);
        response = await readFileTool(
          { ...input, path: readPath.absolutePath },
          { cwd: workspace.root, displayPath: input.path },
        );
      } catch (error) {
        const payload = toolErrorPayload(error);
        if (!payload) throw error;
        const result = toolErrorResponse(payload);
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, result.content, startedAt);
        return result;
      }

      if (response.toolError) {
        const result = toolErrorResponse(response.toolError);
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, result.content, startedAt);
        return result;
      }

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const revision = response.details?.revision;
      if (!revision) {
        throw new Error(`Read succeeded without a file revision: ${input.path}`);
      }

      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
          status: "read" as const,
          revision,
        },
      };
    },
  );

  toolSurface.register({
    server: registrationTarget,
    config,
    workspaces,
    processSessions,
    patchRecovery,
  });

  registerAppTool(
    registrationTarget,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        workspace_id: z.string(),
        review_ref: z.string().regex(/^[0-9a-f]{40,64}$/),
      }),
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }, { _meta }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const reviewRef = typeof _meta?.["devspace/reviewRef"] === "string"
        ? _meta["devspace/reviewRef"]
        : undefined;
      const review = reviewRef
        ? await reviewCheckpoints.reviewByRef({
            workspaceId,
            root: workspace.root,
            reviewRef,
          })
        : await reviewCheckpoints.reviewChanges({
            workspaceId,
            root: workspace.root,
            markReviewed: true,
          });

      const content = [textBlock(review.result)];
      logToolCall(config, {
        tool: "show_changes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          card: {
            workspaceId,
            summary: review.summary,
            files: review.files,
            payload: {
              patch: review.patch,
            },
          },
        },
        structuredContent: {
          workspace_id: workspaceId,
          review_ref: review.reviewRef,
          result: contentText(content),
        },
      };
    },
  );

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(registrationTarget, {
      config,
      workspaces,
      incomingArtifactAdapters,
    });
  }
}

function withTrackedToolHandlers(
  server: McpRegistrationTarget,
  trackToolActivity: TrackToolActivity,
): McpRegistrationTarget {
  return {
    registerTool: ((...args: unknown[]) => {
      const handler = args.at(-1) as (...handlerArgs: unknown[]) => unknown;
      return (server.registerTool as (...callArgs: unknown[]) => unknown)(
        ...args.slice(0, -1),
        (...handlerArgs: unknown[]) => trackToolActivity(
          () => Promise.resolve(handler(...handlerArgs)),
        ),
      );
    }) as McpRegistrationTarget["registerTool"],
    registerResource: server.registerResource.bind(server),
  };
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
  memoryClient?: MemoryClient;
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const patchRecovery = new PatchRecoveryManager(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const memoryThreadAuthorizations = new MemoryThreadAuthorizationStore();
  const memoryClient = options.memoryClient ?? new MemoryAdapter(config.memory);
  const toolActivities = new ToolActivityTracker();
  const localAgentProviders = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
  );
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(process.env, config.subagents),
  );
  const modernToolSurface = getToolSurface(config.toolMode);
  const bindModernMcpSurface = compileMcpRegistrationSurface((target) => {
    registerMcpSurface(
      target,
      config,
      workspaces,
      reviewCheckpoints,
      processSessions,
      resolveLocalAgentProviders,
      incomingArtifactAdapters,
      toolActivities.track,
      memoryClient,
      memoryThreadAuthorizations,
      patchRecovery,
    );
  });
  const logMcpHandlerError = (error: Error) => logEvent(
    config.logging,
    "error",
    "mcp_handler_error",
    modernMcpAdapterErrorLogFields(error),
  );
  const mcpHandler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter(
      mcpServerInfo(),
      { instructions: serverInstructions(config, modernToolSurface) },
    );
    bindModernMcpSurface(adapter.registrationTarget);
    return adapter.server;
  }, {
    legacy: "stateless",
    onerror: logMcpHandlerError,
  });
  const mcpNodeHandler = toNodeHandler(mcpHandler, {
    onerror: logMcpHandlerError,
  });

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace" });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !oauthProvider.isResourceAllowed(req.auth.resource)) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
    });

    try {
      await mcpNodeHandler(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        try {
          await mcpHandler.close();
        } catch (error) {
          logEvent(config.logging, "warn", "mcp_handler_close_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await toolActivities.waitForIdle();
        processSessions.shutdown();
        oauthProvider.close();
        workspaceStore.close?.();
        patchRecovery.close();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const startupConfig = loadConfig();
  await runPatchStartupRecovery(startupConfig);
  const { app, config, close, localAgentProviders } = createServer(startupConfig);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
