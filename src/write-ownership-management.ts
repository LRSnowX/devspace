import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ServerConfig } from "./config.js";
import { ProjectRegistry } from "./project-registry.js";
import { expandHomePath, resolveCanonicalAllowedPath } from "./roots.js";
import { WriteOwnership } from "./write-ownership.js";
import type { DestructiveRetentionRecord } from "./write-ownership-store.js";

type ManagementConfig = Pick<
  ServerConfig,
  "stateDir" | "allowedRoots" | "worktreeRoot" | "projectRegistryPath"
>;

export async function inspectWriteOwnershipCommand(
  config: ManagementConfig,
  args: string[],
) {
  const [command, project, ...extra] = args;
  const ownership = new WriteOwnership(config.stateDir);
  if (command === "list" && !project) return ownership.list();
  if (
    !project ||
    extra.length ||
    (command !== "show" && command !== "recover")
  ) {
    throw new Error(
      "Usage: devspace write-ownership list|show <project-or-path>|recover <project-or-path>",
    );
  }
  let path = expandHomePath(project);
  if (!isAbsolute(path)) {
    const found = new ProjectRegistry(
      config.projectRegistryPath,
      config.allowedRoots,
    ).lookup(project);
    if (found.status !== "found")
      throw new Error(`Project is ${found.status}: ${project}`);
    path = found.resolution.project.path;
  }
  const root = await resolveCanonicalAllowedPath(path, path, [
    ...config.allowedRoots,
    config.worktreeRoot,
  ]);
  return command === "show"
    ? ownership.diagnostics(root)
    : ownership.recover(root, metadataLifecycleSafe);
}

/** Metadata pruning is SQLite-transactional and does not remove checkout files.
 * A worktree guard needs complete child evidence AND a verified Git/filesystem
 * terminal lifecycle. The Git adapter cannot prove exhaustive child evidence
 * after a crash; leave those guards for manual operator inspection. */
function metadataLifecycleSafe(guard: DestructiveRetentionRecord): boolean {
  if (guard.kind !== "workspace_metadata") return false;
  try {
    const metadata = lstatSync(guard.canonical_root);
    return (
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      !!guard.root_identity &&
      metadata.ino !== 0 &&
      String(metadata.dev) === guard.root_identity.dev &&
      String(metadata.ino) === guard.root_identity.ino
    );
  } catch (error) {
    return (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      guard.root_identity === null
    );
  }
}
