import { randomBytes } from "node:crypto";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { ToolOperationError } from "./tool-errors.js";

export type WorkspaceAccess = "inspect" | "modify";
export type AuthorizationDecision = WorkspaceAccess | "deny";
export const WORKSPACE_AUTHORIZATION_TTL_MS = 120_000;
const MAX_PENDING_REQUESTS = 1_024;

export interface WorkspaceAuthorizationRequest {
  request_id: string;
  workspace: string;
  requested_access: WorkspaceAccess;
  expires_at: string;
}

interface PendingRequest {
  conversation: string;
  target: string;
  access: WorkspaceAccess;
  createdAt: number;
  expiresAt: number;
}

// Compiled once at startup, not per MCP session. Restart drops all authority.
export class WorkspaceAuthorization {
  private readonly grants = new Map<string, Map<string, WorkspaceAccess>>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly now: () => number = Date.now) {}

  scope(meta: unknown): string | undefined {
    const scope = conversationScopeIdFromRequestMeta(meta);
    return scope?.trim() ? scope : undefined;
  }

  allows(
    conversation: string,
    target: string,
    access: WorkspaceAccess,
  ): boolean {
    const grant = this.grants.get(conversation)?.get(target);
    return grant === "modify" || grant === access;
  }

  require(conversation: string, target: string, access: WorkspaceAccess): void {
    if (this.allows(conversation, target, access)) return;
    throw new ToolOperationError({
      code: "WORKSPACE_AUTHORIZATION_REQUIRED",
      category: "scope",
      retryable: true,
      message: `User authorization for ${access} access is required. Retry open_workspace with access=${access} and approve its App card.`,
    });
  }

  request(
    conversation: string,
    target: string,
    workspace: string,
    access: WorkspaceAccess,
  ): WorkspaceAuthorizationRequest {
    const now = this.now();
    for (const [id, request] of this.pending) {
      if (request.expiresAt <= now) this.pending.delete(id);
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw invalidRequest(
        "Too many pending authorization requests; retry after expiry.",
      );
    }
    const id = randomBytes(32).toString("hex");
    const expiresAt = now + WORKSPACE_AUTHORIZATION_TTL_MS;
    this.pending.set(id, {
      conversation,
      target,
      access,
      createdAt: now,
      expiresAt,
    });
    return {
      request_id: id,
      workspace,
      requested_access: access,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  decide(
    id: string,
    conversation: string | undefined,
    decision: AuthorizationDecision,
  ): void {
    const request = this.pending.get(id);
    if (!request || !conversation || request.conversation !== conversation) {
      throw invalidRequest(
        "Authorization request is unavailable for this conversation.",
      );
    }
    // A matching attempt consumes the request, including expiry or escalation.
    this.pending.delete(id);
    if (request.expiresAt <= this.now())
      throw invalidRequest("Authorization request expired.");
    if (decision === "modify" && request.access !== "modify") {
      throw invalidRequest("Modify requires a new request for modify access.");
    }
    if (decision === "deny") return;
    const grants =
      this.grants.get(conversation) ?? new Map<string, WorkspaceAccess>();
    if (grants.get(request.target) !== "modify")
      grants.set(request.target, decision);
    this.grants.set(conversation, grants);
  }
}

function invalidRequest(message: string): ToolOperationError {
  return new ToolOperationError({
    code: "WORKSPACE_AUTHORIZATION_REQUEST_INVALID",
    category: "scope",
    message,
    retryable: true,
  });
}
