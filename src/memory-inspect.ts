import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { MemoryClient } from "./memory-adapter.js";
import { ProjectRegistry } from "./project-registry.js";
import { readRepositoryState } from "./repository-state.js";
import { assertAllowedPath, expandHomePath } from "./roots.js";

export interface ProjectMemoryInspection {
  project: {
    name: string;
    path: string;
  };
  repository_state: Record<string, unknown>;
  memory: {
    enabled: boolean;
    context?: Record<string, unknown>;
    context_error?: string;
    health?: Record<string, unknown>;
    health_error?: string;
  };
}

export function resolveMemoryInspectionProject(
  input: string,
  registry: ProjectRegistry,
  allowedRoots: readonly string[],
): { name: string; path: string } {
  if (isAbsolute(input) || input === "~" || input.startsWith("~/") || input.startsWith("~\\")) {
    const allowed = assertAllowedPath(expandHomePath(input), [...allowedRoots]);
    if (!existsSync(allowed) || !statSync(allowed).isDirectory()) {
      throw new Error("Project path is not a directory: " + allowed);
    }
    const path = realpathSync(allowed);
    return {
      name: registry.projectNameForPath(path) ?? basename(path),
      path,
    };
  }

  const lookup = registry.lookup(input);
  if (lookup.status === "found") {
    return {
      name: lookup.resolution.project.name,
      path: lookup.resolution.project.path,
    };
  }
  if (lookup.status === "ambiguous") {
    throw new Error(
      "Project '" + input + "' is ambiguous: " + lookup.paths.join(", "),
    );
  }

  const key = normalizeProjectName(input);
  const matches: string[] = [];
  for (const root of allowedRoots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    discoverGitProjects(resolve(root), key, 0, 4, matches);
  }
  const unique = [...new Set(matches.map((path) => realpathSync(path)))].sort();
  if (unique.length === 0) {
    throw new Error(
      "Unknown project '" + input + "'. Register it, use an absolute path, or place it under an allowed root.",
    );
  }
  if (unique.length > 1) {
    throw new Error(
      "Project '" + input + "' is ambiguous: " + unique.join(", "),
    );
  }
  return {
    name: registry.projectNameForPath(unique[0]!) ?? basename(unique[0]!),
    path: unique[0]!,
  };
}

export async function inspectProjectMemory(input: {
  projectName: string;
  projectPath: string;
  memory: MemoryClient;
  byteBudget: number;
  staleAfterDays?: number;
}): Promise<ProjectMemoryInspection> {
  const repositoryState = await readRepositoryState(input.projectPath);
  const { modelMemoryContext, modelRepositoryState } = await import("./server.js");
  const inspection: ProjectMemoryInspection = {
    project: {
      name: input.projectName,
      path: input.projectPath,
    },
    repository_state: modelRepositoryState(repositoryState) as Record<string, unknown>,
    memory: {
      enabled: input.memory.enabled,
    },
  };
  if (!input.memory.enabled) return inspection;

  try {
    const bootstrap = await input.memory.bootstrapProjectContext(input.projectName);
    inspection.memory.context = modelMemoryContext(
      bootstrap,
      input.byteBudget,
      repositoryState,
    ) as Record<string, unknown>;
  } catch (error) {
    inspection.memory.context_error = errorMessage(error);
  }

  try {
    const result = await input.memory.call("memory_health", {
      project: input.projectName,
      stale_after_days: input.staleAfterDays ?? 30,
    });
    if (!result.structuredContent || typeof result.structuredContent !== "object") {
      throw new Error("CHIM memory_health returned no structured content");
    }
    inspection.memory.health = result.structuredContent as Record<string, unknown>;
  } catch (error) {
    inspection.memory.health_error = errorMessage(error);
  }

  return inspection;
}

export function formatProjectMemoryInspection(inspection: ProjectMemoryInspection): string {
  const lines = [
    "Project memory inspection: " + inspection.project.name,
    "Path: " + inspection.project.path,
  ];
  const repository = inspection.repository_state;
  if (repository.available === true) {
    const branch = typeof repository.branch === "string"
      ? repository.branch
      : repository.detached === true
        ? "(detached)"
        : "(unknown branch)";
    const head = typeof repository.head === "string" ? repository.head.slice(0, 12) : "(unknown)";
    lines.push(
      "Repository: "
        + branch
        + " @ "
        + head
        + (repository.dirty === true ? " · dirty" : " · clean"),
    );
  } else {
    lines.push("Repository: unavailable (" + String(repository.reason ?? "unknown") + ")");
  }

  if (!inspection.memory.enabled) {
    lines.push("Memory: disabled");
    return lines.join("\n");
  }

  if (inspection.memory.context) {
    const context = inspection.memory.context;
    const bootstrapStatus = record(context.bootstrap_status);
    const working = record(context.working_memory);
    const sections = record(context.sections);
    const pendingSection = record(sections?.pending_memory);
    const verification = Array.isArray(working?.verification) ? working.verification : [];
    const flagged = verification.filter((entry) => {
      const value = record(entry);
      return value?.host_state === "needs_revalidation"
        || value?.host_state === "tentative"
        || value?.host_state === "expired";
    }).length;
    lines.push(
      "Handoff: "
        + String(context.bytes_used ?? "?")
        + "/"
        + String(context.byte_budget ?? "?")
        + " bytes · working items "
        + String(Array.isArray(working?.items) ? working.items.length : 0)
        + " · flagged "
        + flagged
        + " · pending "
        + String(pendingSection?.items ?? 0)
        + " items/"
        + String(pendingSection?.bytes ?? 0)
        + " bytes"
        + (pendingSection?.truncated === true ? " (truncated)" : ""),
    );
    lines.push(
      "Bootstrap: "
        + String(bootstrapStatus?.state ?? "unknown")
        + " · active working "
        + String(bootstrapStatus?.active_working_memory_items ?? "?")
        + " · estimated model attempts "
        + String(bootstrapStatus?.estimated_model_attempts ?? "?")
        + " · selected conversations "
        + String(bootstrapStatus?.selected_conversations ?? "?"),
    );
  } else {
    lines.push("Handoff: unavailable (" + String(inspection.memory.context_error ?? "unknown") + ")");
  }

  if (inspection.memory.health) {
    const health = inspection.memory.health;
    const items = record(health.memory_items);
    const candidates = record(health.candidates);
    lines.push(
      "CHIM health: active "
        + String(items?.active ?? "?")
        + " · pending candidates "
        + String(candidates?.pending ?? "?")
        + " · checkpoints "
        + String(health.checkpoint_count ?? "?")
        + " · incomplete evidence "
        + String(health.incomplete_canonical_conversation_count ?? "?"),
    );
  } else {
    lines.push("CHIM health: unavailable (" + String(inspection.memory.health_error ?? "unknown") + ")");
  }

  return lines.join("\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function discoverGitProjects(
  directory: string,
  targetKey: string,
  depth: number,
  maxDepth: number,
  matches: string[],
): void {
  if (depth > maxDepth) return;
  const gitMarker = join(directory, ".git");
  if (existsSync(gitMarker)) {
    if (normalizeProjectName(basename(directory)) === targetKey) matches.push(directory);
    return;
  }
  if (depth === maxDepth) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) {
      continue;
    }
    discoverGitProjects(join(directory, entry.name), targetKey, depth + 1, maxDepth, matches);
  }
}

function normalizeProjectName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
