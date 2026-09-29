import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";

export type PatchOperation = "add" | "update" | "delete" | "move";

export interface AppliedPatchFile {
  path: string;
  previousPath?: string;
  operation: PatchOperation;
}

export interface ApplyPatchResult {
  files: AppliedPatchFile[];
  patch: string;
  additions: number;
  removals: number;
}

export interface ApplyPatchOptions {
  beforeCommit?: (input: {
    paths: readonly string[];
    files: readonly AppliedPatchFile[];
  }) => Promise<void> | void;
  beforePublish?: (input: {
    path: string;
    index: number;
  }) => Promise<void> | void;
  beforeRollback?: (input: {
    path: string;
    index: number;
  }) => Promise<void> | void;
}

interface HunkLine {
  kind: "context" | "add" | "remove";
  text: string;
}

interface UpdateHunk {
  lines: HunkLine[];
  changeContext?: string;
  endOfFile?: boolean;
}

type PatchAction =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: UpdateHunk[] };

interface TextFile {
  content: string;
  mode?: number;
}

type StagedTextFile = TextFile | null;
interface PreparedFile {
  path: string;
}
interface PublishedMutation {
  path: string;
  completed: boolean;
}
type FileIdentity = Pick<Stats, "dev" | "ino">;
type FileIdentityReader = (path: string) => Promise<FileIdentity>;
const patchLocks = new Map<string, Promise<void>>();

function patchError(message: string): Error {
  return new Error(`Invalid patch: ${message}`);
}

export function parsePatch(patch: string): PatchAction[] {
  const lines = patchLines(patch);
  if (lines.shift()?.trim() !== "*** Begin Patch") {
    throw patchError("missing *** Begin Patch marker");
  }
  if (lines.pop()?.trim() !== "*** End Patch") {
    throw patchError("missing *** End Patch marker");
  }

  const actions: PatchAction[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index++].trim();
    if (header === "") continue;

    if (header.startsWith("*** Environment ID: ")) {
      if (!header.slice("*** Environment ID: ".length).trim()) {
        throw patchError("environment id cannot be empty");
      }
      continue;
    }

    if (header.startsWith("*** Add File: ")) {
      const path = header.slice("*** Add File: ".length);
      const content: string[] = [];
      while (index < lines.length && !isTopLevelHeader(lines[index])) {
        const line = lines[index++];
        if (!line.startsWith("+")) {
          throw patchError(`added file line must start with +: ${line}`);
        }
        content.push(line.slice(1));
      }
      if (content.length === 0) throw patchError(`add file for ${path} has no content`);
      actions.push({
        kind: "add",
        path,
        content: `${content.join("\n")}\n`,
      });
      continue;
    }

    if (header.startsWith("*** Delete File: ")) {
      actions.push({ kind: "delete", path: header.slice("*** Delete File: ".length) });
      continue;
    }

    if (header.startsWith("*** Update File: ")) {
      const path = header.slice("*** Update File: ".length);
      let moveTo: string | undefined;
      const hunks: UpdateHunk[] = [];

      if (lines[index]?.trim().startsWith("*** Move to: ")) {
        moveTo = lines[index++].trim().slice("*** Move to: ".length);
      }

      let current: UpdateHunk | undefined;
      const finishCurrent = (): void => {
        if (!current) return;
        if (current.lines.length === 0) throw patchError(`empty update hunk for ${path}`);
        hunks.push(current);
        current = undefined;
      };

      while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();
        if (!current && trimmed === "") {
          index++;
          continue;
        }
        if (trimmed === "*** End of File") {
          if (!current) throw patchError(`end-of-file marker without update hunk for ${path}`);
          current.endOfFile = true;
          index++;
          continue;
        }

        if ((!current || !line.startsWith(" ")) && isTopLevelHeader(line)) break;

        if (trimmed.startsWith("@@") && !line.startsWith(" ")) {
          finishCurrent();
          const changeContext = trimmed.slice(2).trim();
          current = { lines: [], changeContext: changeContext || undefined };
          index++;
          continue;
        }

        current ??= { lines: [] };
        index++;
        if (line.startsWith(" ")) current.lines.push({ kind: "context", text: line.slice(1) });
        else if (line.startsWith("+")) current.lines.push({ kind: "add", text: line.slice(1) });
        else if (line.startsWith("-")) current.lines.push({ kind: "remove", text: line.slice(1) });
        else if (line === "\\ No newline at end of file") continue;
        else throw patchError(`hunk line must start with space, +, or -: ${line}`);
      }
      finishCurrent();

      if (hunks.length === 0 && !moveTo) {
        throw patchError(`update for ${path} has no hunks or move destination`);
      }
      actions.push({ kind: "update", path, moveTo, hunks });
      continue;
    }

    throw patchError(`unknown action header: ${header}`);
  }

  if (actions.length === 0) throw patchError("contains no file actions");
  return actions;
}

function patchLines(patch: string): string[] {
  let lines = patch.replace(/\r\n/g, "\n").trim().split("\n");
  const first = lines[0]?.trim();
  const last = lines.at(-1)?.trim();
  if (
    (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
    last?.endsWith("EOF") &&
    lines.length >= 4
  ) {
    lines = lines.slice(1, -1);
  }
  return lines;
}

function isTopLevelHeader(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("*** Add File: ") ||
    trimmed.startsWith("*** Delete File: ") ||
    trimmed.startsWith("*** Update File: ") ||
    trimmed.startsWith("*** Environment ID: ")
  );
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveConfinedPath(root: string, input: string): Promise<string> {
  if (!input || input.includes("\0") || isAbsolute(input)) {
    throw patchError(`path must be relative to the workspace: ${input}`);
  }

  const rootPath = await realpath(root);
  const target = resolve(rootPath, input);
  if (!isInside(rootPath, target)) {
    throw patchError(`path escapes the workspace: ${input}`);
  }

  let existing = target;
  while (true) {
    try {
      const resolved = await realpath(existing);
      if (!isInside(rootPath, resolved)) {
        throw patchError(`path resolves outside the workspace: ${input}`);
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }

  return target;
}

function splitFile(content: string): { lines: string[]; eol: string; finalNewline: boolean } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function findSequence(haystack: string[], needle: string[], from: number, endOfFile = false): number {
  if (needle.length === 0) return from;

  const matchAt = (index: number, normalize: (value: string) => string): boolean =>
    needle.every((line, offset) => normalize(haystack[index + offset] ?? "") === normalize(line));

  for (const normalize of [
    (value: string) => value,
    (value: string) => value.trimEnd(),
    (value: string) => value.trim(),
  ]) {
    const start = endOfFile ? haystack.length - needle.length : from;
    const end = haystack.length - needle.length;
    for (let index = start; index <= end; index += 1) {
      if (index >= from && matchAt(index, normalize)) return index;
    }
  }

  return -1;
}

function applyHunks(path: string, content: string, hunks: UpdateHunk[]): string {
  const file = splitFile(content);
  const lines = [...file.lines];
  let cursor = 0;

  for (const hunk of hunks) {
    if (hunk.changeContext) {
      const contextIndex = findSequence(lines, [hunk.changeContext], cursor);
      if (contextIndex < 0) {
        throw patchError(`could not find hunk context in ${path}: ${hunk.changeContext}`);
      }
      cursor = contextIndex + 1;
    }

    const oldLines = hunk.lines
      .filter((line) => line.kind !== "add")
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.kind !== "remove")
      .map((line) => line.text);
    const index = hunk.endOfFile && oldLines.length === 0
      ? lines.length
      : findSequence(lines, oldLines, cursor, hunk.endOfFile);

    if (index < 0) {
      const preview = oldLines.slice(0, 3).join("\n");
      throw patchError(`could not find hunk context in ${path}: ${preview}`);
    }

    lines.splice(index, oldLines.length, ...newLines);
    cursor = index + newLines.length;
  }

  const normalized = `${lines.join("\n")}\n`;
  return file.eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function replaceFile(
  temporary: string,
  destination: string,
  destinationExists: boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32" || !destinationExists) {
    await rename(temporary, destination);
    return;
  }

  const backup = `${temporary}.original`;
  await rename(destination, backup);
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rename(backup, destination);
    throw error;
  }
  await rm(backup, { force: true });
}

export async function isSamePatchFile(
  source: string,
  destination: string,
  readIdentity: FileIdentityReader = lstat,
): Promise<boolean> {
  if (source === destination) return true;
  if (source.toLowerCase() !== destination.toLowerCase()) return false;

  try {
    const [sourceIdentity, destinationIdentity] = await Promise.all([
      readIdentity(source),
      readIdentity(destination),
    ]);
    return sourceIdentity.dev === destinationIdentity.dev && sourceIdentity.ino === destinationIdentity.ino;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

export async function applyPatch(
  root: string,
  patch: string,
  options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
  const lockKey = await realpath(root);
  return withPatchLock(lockKey, () => applyPatchUnlocked(root, patch, options));
}

async function applyPatchUnlocked(
  root: string,
  patch: string,
  options: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
  const actions = parsePatch(patch);
  const results: AppliedPatchFile[] = [];
  const patches: string[] = [];
  const staged = new Map<string, StagedTextFile>();
  const originals = new Map<string, StagedTextFile>();
  const displayPaths = new Map<string, string>();

  const readStagedOptional = async (absolute: string, displayPath: string): Promise<StagedTextFile> => {
    if (staged.has(absolute)) return staged.get(absolute) ?? null;
    const file = await readOptionalTextFile(absolute, displayPath);
    originals.set(absolute, file);
    displayPaths.set(absolute, displayPath);
    staged.set(absolute, file);
    return file;
  };

  const readStagedRequired = async (absolute: string, displayPath: string): Promise<TextFile> => {
    const file = await readStagedOptional(absolute, displayPath);
    if (!file) throw patchError(`file does not exist: ${displayPath}`);
    return file;
  };

  for (const action of actions) {
    if (action.kind === "add") {
      const absolute = await resolveConfinedPath(root, action.path);
      const original = await readStagedOptional(absolute, action.path);
      staged.set(absolute, { content: action.content, mode: original?.mode });
      patches.push(unifiedFilePatch(action.path, action.path, original?.content ?? null, action.content));
      results.push({ path: action.path, operation: original ? "update" : "add" });
      continue;
    }

    const absolute = await resolveConfinedPath(root, action.path);
    const file = await readStagedRequired(absolute, action.path);

    if (action.kind === "delete") {
      staged.set(absolute, null);
      patches.push(unifiedFilePatch(action.path, action.path, file.content, null));
      results.push({ path: action.path, operation: "delete" });
      continue;
    }

    const updated = applyHunks(action.path, file.content, action.hunks);
    if (action.moveTo) {
      const destination = await resolveConfinedPath(root, action.moveTo);
      const samePatchFile = await isSamePatchFile(absolute, destination);
      if (!samePatchFile) await readStagedOptional(destination, action.moveTo);
      else if (!originals.has(destination)) {
        originals.set(destination, originals.get(absolute) ?? file);
        displayPaths.set(destination, action.moveTo);
      }
      if (samePatchFile) staged.delete(absolute);
      staged.set(destination, { content: updated, mode: file.mode });
      if (!samePatchFile) staged.set(absolute, null);
      patches.push(unifiedFilePatch(action.path, action.moveTo, file.content, updated));
      results.push({ path: action.moveTo, previousPath: action.path, operation: "move" });
    } else {
      staged.set(absolute, { content: updated, mode: file.mode });
      patches.push(unifiedFilePatch(action.path, action.path, file.content, updated));
      results.push({ path: action.path, operation: "update" });
    }
  }

  await publishStagedPatch(staged, originals, displayPaths, results, options);

  const unifiedPatch = patches.filter(Boolean).join("\n");
  const stats = countPatchStats(unifiedPatch);
  return { files: results, patch: unifiedPatch, ...stats };
}

async function withPatchLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = patchLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = previous.then(() => current);
  patchLocks.set(key, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (patchLocks.get(key) === tail) patchLocks.delete(key);
  }
}

async function publishStagedPatch(
  staged: ReadonlyMap<string, StagedTextFile>,
  originals: ReadonlyMap<string, StagedTextFile>,
  displayPaths: ReadonlyMap<string, string>,
  files: readonly AppliedPatchFile[],
  options: ApplyPatchOptions,
): Promise<void> {
  const preparedFinals = new Map<string, PreparedFile>();
  const preparedOriginals = new Map<string, PreparedFile>();
  const createdDirectories = new Set<string>();
  const mutated: PublishedMutation[] = [];

  try {
    for (const [absolute, file] of staged) {
      const displayPath = displayPaths.get(absolute) ?? absolute;
      const original = originals.get(absolute) ?? null;
      if (file) {
        preparedFinals.set(
          absolute,
          await prepareTextFile(absolute, file, createdDirectories),
        );
      }
      if (original) {
        preparedOriginals.set(
          absolute,
          await prepareTextFile(absolute, original, createdDirectories),
        );
      }
      if (!displayPaths.has(absolute)) {
        throw patchError(`missing display path for staged file: ${displayPath}`);
      }
    }

    await options.beforeCommit?.({
      paths: [...staged.keys()],
      files,
    });

    for (const [absolute] of staged) {
      await assertPatchBaseline(
        absolute,
        originals.get(absolute) ?? null,
        displayPaths.get(absolute) ?? absolute,
      );
    }

    const publicationOrder = [
      ...[...staged.entries()].filter(([, file]) => file !== null),
      ...[...staged.entries()].filter(([, file]) => file === null),
    ] as Array<[string, StagedTextFile]>;

    for (const [index, [absolute, file]] of publicationOrder.entries()) {
      const displayPath = displayPaths.get(absolute) ?? absolute;
      await assertPatchBaseline(
        absolute,
        originals.get(absolute) ?? null,
        displayPath,
      );
      await options.beforePublish?.({ path: displayPath, index });
      await assertPatchBaseline(
        absolute,
        originals.get(absolute) ?? null,
        displayPath,
      );

      if (file) {
        const prepared = preparedFinals.get(absolute);
        if (!prepared) throw patchError(`missing prepared file: ${displayPath}`);
        const mutation = { path: absolute, completed: false };
        mutated.push(mutation);
        await replaceFile(prepared.path, absolute, await fileExists(absolute));
        mutation.completed = true;
        preparedFinals.delete(absolute);
      } else {
        const mutation = { path: absolute, completed: false };
        mutated.push(mutation);
        await rm(absolute, { force: true });
        mutation.completed = true;
      }
    }
  } catch (error) {
    const rollbackErrors = await rollbackPublishedPatch(
      mutated,
      staged,
      originals,
      preparedOriginals,
      displayPaths,
      options,
    );
    const cleanupErrors = [
      ...(await cleanupPreparedFiles(preparedFinals)),
      ...(rollbackErrors.length === 0
        ? await cleanupPreparedFiles(preparedOriginals)
        : []),
      ...(await cleanupCreatedDirectories(createdDirectories)),
    ];
    const originalMessage = error instanceof Error ? error.message : String(error);
    if (rollbackErrors.length > 0) {
      const recoveryFiles = [...preparedOriginals.values()].map(({ path }) => path);
      throw new Error(
        [
          originalMessage,
          `rollback failed: ${rollbackErrors.join("; ")}`,
          recoveryFiles.length > 0
            ? `recovery files retained: ${recoveryFiles.join(", ")}`
            : undefined,
          cleanupErrors.length > 0
            ? `cleanup failed: ${cleanupErrors.join("; ")}`
            : undefined,
        ].filter(Boolean).join("; "),
        { cause: error },
      );
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `${originalMessage}; cleanup failed after rollback: ${cleanupErrors.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }

  await cleanupPreparedFiles(preparedOriginals);
  await cleanupPreparedFiles(preparedFinals);
}

async function rollbackPublishedPatch(
  mutated: readonly PublishedMutation[],
  staged: ReadonlyMap<string, StagedTextFile>,
  originals: ReadonlyMap<string, StagedTextFile>,
  preparedOriginals: Map<string, PreparedFile>,
  displayPaths: ReadonlyMap<string, string>,
  options: ApplyPatchOptions,
): Promise<string[]> {
  const errors: string[] = [];
  const reversed = [...mutated].reverse();

  for (const [index, mutation] of reversed.entries()) {
    const absolute = mutation.path;
    const displayPath = displayPaths.get(absolute) ?? absolute;
    try {
      await options.beforeRollback?.({ path: displayPath, index });
      const shouldRestore = await shouldRestorePublishedPath(
        absolute,
        staged.get(absolute) ?? null,
        originals.get(absolute) ?? null,
        displayPath,
        mutation.completed,
      );
      if (!shouldRestore) continue;
      const original = originals.get(absolute) ?? null;
      if (original) {
        const prepared = preparedOriginals.get(absolute);
        if (!prepared) throw patchError(`missing rollback file: ${displayPath}`);
        await replaceFile(prepared.path, absolute, await fileExists(absolute));
        preparedOriginals.delete(absolute);
      } else {
        await rm(absolute, { force: true });
      }
    } catch (error) {
      errors.push(
        `${displayPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return errors;
}

async function assertPatchBaseline(
  absolute: string,
  expected: StagedTextFile,
  displayPath: string,
): Promise<void> {
  const actual = await readOptionalTextFile(absolute, displayPath);
  if (!sameTextFile(actual, expected)) {
    throw patchError(`file changed during patch application: ${displayPath}`);
  }
}

async function shouldRestorePublishedPath(
  absolute: string,
  published: StagedTextFile,
  original: StagedTextFile,
  displayPath: string,
  completed: boolean,
): Promise<boolean> {
  const actual = await readOptionalTextFile(absolute, displayPath);
  if (sameTextFile(actual, original)) return false;
  if (sameTextFile(actual, published, { ignoreModeWhenExpectedMissing: true })) {
    return true;
  }
  if (!completed && actual === null) {
    return original !== null;
  }
  throw patchError(`published file changed before rollback: ${displayPath}`);
}

function sameTextFile(
  actual: StagedTextFile,
  expected: StagedTextFile,
  options: { ignoreModeWhenExpectedMissing?: boolean } = {},
): boolean {
  if (actual === null || expected === null) return actual === expected;
  if (actual.content !== expected.content) return false;
  if (expected.mode === undefined && options.ignoreModeWhenExpectedMissing) return true;
  return actual.mode === expected.mode;
}

async function prepareTextFile(
  destination: string,
  file: TextFile,
  createdDirectories: Set<string>,
): Promise<PreparedFile> {
  await ensureParentDirectory(destination, createdDirectories);
  const temporary = `${destination}.devspace-patch-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporary,
      file.content,
      file.mode === undefined ? undefined : { mode: file.mode },
    );
    return { path: temporary };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensureParentDirectory(
  destination: string,
  createdDirectories: Set<string>,
): Promise<void> {
  const parent = dirname(destination);
  const missing: string[] = [];
  let current = parent;
  while (!(await fileExists(current))) {
    missing.push(current);
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  await mkdir(parent, { recursive: true });
  for (const path of missing) createdDirectories.add(path);
}

async function cleanupPreparedFiles(
  prepared: ReadonlyMap<string, PreparedFile>,
): Promise<string[]> {
  const errors: string[] = [];
  for (const { path } of prepared.values()) {
    for (const candidate of [path, `${path}.original`]) {
      try {
        await rm(candidate, { force: true });
      } catch (error) {
        errors.push(
          `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return errors;
}

async function cleanupCreatedDirectories(
  createdDirectories: ReadonlySet<string>,
): Promise<string[]> {
  const errors: string[] = [];
  const deepestFirst = [...createdDirectories].sort(
    (left, right) => right.length - left.length,
  );
  for (const path of deepestFirst) {
    try {
      await rmdir(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return errors;
}

async function readOptionalTextFile(absolute: string, displayPath: string): Promise<TextFile | null> {
  if (!(await fileExists(absolute))) return null;
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw patchError(`path is not a regular file: ${displayPath}`);
  return { content: await readUtf8Text(absolute, displayPath), mode: metadata.mode };
}

async function readUtf8Text(absolute: string, displayPath: string): Promise<string> {
  const bytes = await readFile(absolute);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw patchError(`file is not valid UTF-8 text: ${displayPath}`);
  }
  if (content.includes("\0")) throw patchError(`file appears to be binary: ${displayPath}`);
  return content;
}

function unifiedFilePatch(
  oldPath: string,
  newPath: string,
  oldContent: string | null,
  newContent: string | null,
): string {
  const oldFileName = oldContent === null ? "/dev/null" : `a/${oldPath}`;
  const newFileName = newContent === null ? "/dev/null" : `b/${newPath}`;
  const body = createTwoFilesPatch(
    oldFileName,
    newFileName,
    oldContent ?? "",
    newContent ?? "",
    "",
    "",
    { context: 3, headerOptions: FILE_HEADERS_ONLY },
  );

  return [
    `diff --git a/${oldPath} b/${newPath}`,
    oldContent === null ? "new file mode 100644" : undefined,
    newContent === null ? "deleted file mode 100644" : undefined,
    stripFinalNewline(body),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function stripFinalNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function countPatchStats(patch: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
  }
  return { additions, removals };
}
