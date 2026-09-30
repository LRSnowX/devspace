import * as z from "zod/v4";

export const TOOL_ERROR_CODES = [
  "PATCH_INVALID",
  "REVISION_CONFLICT",
  "PATH_STATE_CONFLICT",
  "CONCURRENT_MODIFICATION",
  "ROLLBACK_FAILED",
  "PATCH_RECOVERY_REQUIRED",
  "PATH_SCOPE_VIOLATION",
  "FILE_NOT_FOUND",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_INVALIDATED",
  "PROCESS_SESSION_NOT_FOUND",
  "PROCESS_SESSION_SCOPE_MISMATCH",
  "PROCESS_SESSION_NOT_INTERACTIVE",
  "REPEATED_FAILURE",
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
  expected_revision?: string;
  current_revision?: string;
  expected_state?: "absent" | "present";
  current_state?: "absent" | "present";
  recovery_files?: string[];
  session_id?: number;
  repeat_count?: number;
  previous_error_code?: ToolErrorCode;
}

export const toolErrorPayloadSchema = z.object({
  code: z.enum(TOOL_ERROR_CODES),
  category: z.enum(TOOL_ERROR_CATEGORIES),
  message: z.string(),
  retryable: z.boolean(),
  path: z.string().optional(),
  expected_revision: z.string().optional(),
  current_revision: z.string().optional(),
  expected_state: z.enum(["absent", "present"]).optional(),
  current_state: z.enum(["absent", "present"]).optional(),
  recovery_files: z.array(z.string()).optional(),
  session_id: z.number().int().positive().optional(),
  repeat_count: z.number().int().positive().optional(),
  previous_error_code: z.enum(TOOL_ERROR_CODES).optional(),
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
  return isToolOperationError(error) ? error.payload : undefined;
}
