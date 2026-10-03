import * as z from "zod/v4";
import { WriteOwnershipError } from "./write-ownership.js";

export const TOOL_ERROR_CODES = [
  "PATCH_INVALID",
  "REVISION_CONFLICT",
  "PATH_STATE_CONFLICT",
  "CONCURRENT_MODIFICATION",
  "ROLLBACK_FAILED",
  "PATCH_RECOVERY_REQUIRED",
  "PATH_SCOPE_VIOLATION",
  "FILE_NOT_FOUND",
  "PROJECT_NOT_FOUND",
  "PROJECT_AMBIGUOUS",
  "PROJECT_NOT_DIRECTORY",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_INVALIDATED",
  "MEMORY_THREAD_NOT_AUTHORIZED",
  "PROCESS_SESSION_NOT_FOUND",
  "PROCESS_SESSION_SCOPE_MISMATCH",
  "PROCESS_SESSION_NOT_INTERACTIVE",
  "REPEATED_FAILURE",
  "WRITE_OWNERSHIP_REQUIRED",
  "WRITE_OWNERSHIP_CONFLICT",
  "WRITE_OWNERSHIP_BUSY",
  "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
] as const;

export type ToolErrorCode = typeof TOOL_ERROR_CODES[number];

export const TOOL_ERROR_CATEGORIES = [
  "invalid_request",
  "conflict",
  "recovery",
  "scope",
  "not_found",
  "state",
] as const;

export type ToolErrorCategory = typeof TOOL_ERROR_CATEGORIES[number];

export interface ToolErrorPayload {
  code: ToolErrorCode;
  category: ToolErrorCategory;
  message: string;
  retryable: boolean;
  path?: string;
  candidate_paths?: string[];
  expected_revision?: string;
  current_revision?: string;
  expected_state?: "absent" | "present";
  current_state?: "absent" | "present";
  recovery_files?: string[];
  conversation_id?: string;
  session_id?: number;
  repeat_count?: number;
  previous_error_code?: ToolErrorCode;
  owner_workspace_id?: string;
  active_mutation_count?: number;
}

export const toolErrorPayloadSchema = z.object({
  code: z.enum(TOOL_ERROR_CODES),
  category: z.enum(TOOL_ERROR_CATEGORIES),
  message: z.string(),
  retryable: z.boolean(),
  path: z.string().optional(),
  candidate_paths: z.array(z.string()).optional(),
  expected_revision: z.string().optional(),
  current_revision: z.string().optional(),
  expected_state: z.enum(["absent", "present"]).optional(),
  current_state: z.enum(["absent", "present"]).optional(),
  recovery_files: z.array(z.string()).optional(),
  conversation_id: z.string().optional(),
  session_id: z.number().int().positive().optional(),
  repeat_count: z.number().int().positive().optional(),
  previous_error_code: z.enum(TOOL_ERROR_CODES).optional(),
  owner_workspace_id: z.string().optional(),
  active_mutation_count: z.number().int().nonnegative().optional(),
});

export class ToolOperationError extends Error {
  readonly payload: ToolErrorPayload;

  constructor(payload: ToolErrorPayload, options: ErrorOptions = {}) {
    super(payload.message, options);
    this.name = "ToolOperationError";
    this.payload = payload;
  }
}

export function isToolOperationError(error: unknown): error is ToolOperationError {
  return error instanceof ToolOperationError;
}

export function toolErrorPayload(error: unknown): ToolErrorPayload | undefined {
  if (error instanceof WriteOwnershipError) {
    return {
      code: error.code,
      category:
        error.code === "WRITE_OWNERSHIP_REQUIRED"
          ? "state"
          : error.code === "WRITE_OWNERSHIP_RECOVERY_REQUIRED"
            ? "recovery"
            : "conflict",
      message: error.message,
      retryable: error.code !== "WRITE_OWNERSHIP_RECOVERY_REQUIRED",
      ...(error.record
        ? {
            owner_workspace_id: error.record.owner_workspace_id,
            active_mutation_count: error.record.active_mutations.length,
          }
        : {}),
    };
  }
  return isToolOperationError(error) ? error.payload : undefined;
}
