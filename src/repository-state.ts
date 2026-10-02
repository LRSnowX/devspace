import { git, getGitEligibility } from "./git.js";

const MAX_CHANGE_SAMPLE = 20;
const MAX_PATH_CHARS = 320;

export interface RepositoryChangeSample {
  status: string;
  path: string;
}

export interface RepositoryState {
  available: boolean;
  reason?: "not_git" | "unborn_head" | "git_error";
  gitRoot?: string;
  branch?: string;
  head?: string;
  detached?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  modified?: number;
  deleted?: number;
  renamed?: number;
  untracked?: number;
  conflicted?: number;
  changes?: RepositoryChangeSample[];
  changesTruncated?: boolean;
}

export async function readRepositoryState(cwd: string): Promise<RepositoryState> {
  let eligibility;
  try {
    eligibility = await getGitEligibility(cwd);
  } catch {
    return { available: false, reason: "git_error" };
  }
  if (!eligibility.ok || !eligibility.gitRoot) {
    return { available: false, reason: "not_git" };
  }
  if (!eligibility.hasHead) {
    return {
      available: false,
      reason: "unborn_head",
      gitRoot: eligibility.gitRoot,
    };
  }

  try {
    const gitRoot = eligibility.gitRoot;
    const head = (await git(gitRoot, ["rev-parse", "HEAD"])).stdout.trim();
    let branch: string | undefined;
    try {
      branch = (await git(gitRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim()
        || undefined;
    } catch {
      branch = undefined;
    }
    const detached = branch === undefined;

    let upstream: string | undefined;
    let ahead: number | undefined;
    let behind: number | undefined;
    try {
      upstream = (await git(gitRoot, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ])).stdout.trim() || undefined;
      if (upstream) {
        const counts = (await git(gitRoot, [
          "rev-list",
          "--left-right",
          "--count",
          "HEAD..." + upstream,
        ])).stdout.trim().split(/\s+/);
        ahead = Number.parseInt(counts[0] ?? "", 10);
        behind = Number.parseInt(counts[1] ?? "", 10);
        if (!Number.isFinite(ahead)) ahead = undefined;
        if (!Number.isFinite(behind)) behind = undefined;
      }
    } catch {
      upstream = undefined;
      ahead = undefined;
      behind = undefined;
    }

    const porcelain = (await git(gitRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
    ])).stdout;
    const parsed = parsePorcelainV1Z(porcelain);
    return {
      available: true,
      gitRoot,
      branch,
      head,
      detached,
      upstream,
      ahead,
      behind,
      dirty: parsed.total > 0,
      modified: parsed.modified,
      deleted: parsed.deleted,
      renamed: parsed.renamed,
      untracked: parsed.untracked,
      conflicted: parsed.conflicted,
      changes: parsed.changes,
      changesTruncated: parsed.total > parsed.changes.length,
    };
  } catch {
    return {
      available: false,
      reason: "git_error",
      gitRoot: eligibility.gitRoot,
    };
  }
}

interface ParsedPorcelain {
  total: number;
  modified: number;
  deleted: number;
  renamed: number;
  untracked: number;
  conflicted: number;
  changes: RepositoryChangeSample[];
}

export function parsePorcelainV1Z(output: string): ParsedPorcelain {
  const parts = output.split("\0");
  const changes: RepositoryChangeSample[] = [];
  let total = 0;
  let modified = 0;
  let deleted = 0;
  let renamed = 0;
  let untracked = 0;
  let conflicted = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry || entry.length < 3) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    total += 1;

    if (status === "??") untracked += 1;
    if (status.includes("D")) deleted += 1;
    if (status.includes("R") || status.includes("C")) renamed += 1;
    if (status.includes("M") || status.includes("A") || status.includes("T")) modified += 1;
    if (status.includes("U") || status === "AA" || status === "DD") conflicted += 1;

    if (changes.length < MAX_CHANGE_SAMPLE) {
      changes.push({
        status,
        path: clipPath(path),
      });
    }

    if (status.includes("R") || status.includes("C")) index += 1;
  }

  return {
    total,
    modified,
    deleted,
    renamed,
    untracked,
    conflicted,
    changes,
  };
}

function clipPath(path: string): string {
  if (path.length <= MAX_PATH_CHARS) return path;
  return path.slice(0, MAX_PATH_CHARS - 1) + "…";
}
