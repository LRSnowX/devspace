import * as z from "zod/v4";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { FILE_REVISION_PATTERN } from "./file-revision.js";
import type {
  PatchTransactionManifest,
  PatchTransactionRecord,
  PatchTransactionState,
} from "./patch-transaction-types.js";

const stateSchema = z.enum([
  "preparing", "prepared", "committing", "committed", "recovery_required",
]);
const fileStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({
    kind: z.literal("present"),
    revision: z.string().regex(FILE_REVISION_PATTERN),
    mode: z.number().int().nonnegative().optional(),
  }).strict(),
]);
const manifestSchema = z.object({
  id: z.string().uuid(),
  root: z.string().min(1),
  files: z.array(z.object({
    path: z.string().min(1),
    original: fileStateSchema,
    published: fileStateSchema,
    finalPath: z.string().min(1).optional(),
    recoveryPath: z.string().min(1).optional(),
    replacementBackupPath: z.string().min(1).optional(),
    recoveryReplacementBackupPath: z.string().min(1).optional(),
  }).strict()).min(1),
}).strict();

interface RawPatchTransaction {
  id: string;
  root: string;
  state: string;
  manifest_json: string;
  diagnostic_json: string | null;
  created_at: string;
  updated_at: string;
}

export class PatchTransactionStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createPreparing(manifest: PatchTransactionManifest): void {
    const parsed = manifestSchema.parse(manifest);
    const now = new Date().toISOString();
    this.database.sqlite.transaction(() => {
      if (this.hasUnresolvedRoot(parsed.root)) {
        throw new Error(`Patch transaction already unresolved for root: ${parsed.root}`);
      }
      this.database.sqlite.prepare(`
        insert into patch_transactions
          (id, root, state, manifest_json, diagnostic_json, created_at, updated_at)
        values (?, ?, 'preparing', ?, null, ?, ?)
      `).run(parsed.id, parsed.root, JSON.stringify(parsed), now, now);
    }).immediate();
  }

  markPrepared(id: string): void {
    this.transition(id, "preparing", "prepared");
  }

  markCommitting(id: string): void {
    this.transition(id, "prepared", "committing");
  }

  markCommitted(id: string): void {
    this.transition(id, "committing", "committed");
  }

  markRecoveryRequired(id: string, diagnostic: string): void {
    const result = this.database.sqlite.prepare(`
      update patch_transactions
      set state = 'recovery_required', diagnostic_json = ?, updated_at = ?
      where id = ? and state != 'committed'
    `).run(JSON.stringify({ message: diagnostic }), new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error(`Cannot mark patch transaction for recovery: ${id}`);
  }

  hasUnresolvedRoot(root: string): boolean {
    return this.database.sqlite.prepare(`
      select 1 from patch_transactions
      where root = ? and state != 'committed' limit 1
    `).get(root) !== undefined;
  }

  hasRecoveryRequiredRoot(root: string): boolean {
    return this.database.sqlite.prepare(`
      select 1 from patch_transactions
      where root = ? and (
        state = 'recovery_required'
        or state not in ('preparing', 'prepared', 'committing', 'committed')
      ) limit 1
    `).get(root) !== undefined;
  }

  list(): PatchTransactionRecord[] {
    const rows = this.database.sqlite.prepare(`
      select * from patch_transactions order by created_at, id
    `).all() as RawPatchTransaction[];
    return rows.map(decodeRecord);
  }

  get(id: string): PatchTransactionRecord | undefined {
    const row = this.database.sqlite.prepare(
      "select * from patch_transactions where id = ?",
    ).get(id) as RawPatchTransaction | undefined;
    return row ? decodeRecord(row) : undefined;
  }

  delete(id: string): void {
    this.database.sqlite.prepare("delete from patch_transactions where id = ?").run(id);
  }

  close(): void {
    this.database.close();
  }

  private transition(id: string, from: PatchTransactionState, to: PatchTransactionState): void {
    const result = this.database.sqlite.prepare(`
      update patch_transactions set state = ?, updated_at = ?
      where id = ? and state = ?
    `).run(to, new Date().toISOString(), id, from);
    if (result.changes !== 1) {
      throw new Error(`Invalid patch transaction transition ${from} -> ${to}: ${id}`);
    }
  }
}

function decodeRecord(row: RawPatchTransaction): PatchTransactionRecord {
  let manifest: PatchTransactionManifest | undefined;
  let manifestError: string | undefined;
  try {
    manifest = manifestSchema.parse(JSON.parse(row.manifest_json));
    if (manifest.id !== row.id || manifest.root !== row.root) {
      throw new Error("manifest identity differs from indexed transaction columns");
    }
  } catch (error) {
    manifestError = error instanceof Error ? error.message : String(error);
  }
  const stateResult = stateSchema.safeParse(row.state);
  if (!stateResult.success) {
    manifestError = `${manifestError ? `${manifestError}; ` : ""}invalid journal state: ${row.state}`;
  }
  let diagnostic: string | undefined;
  if (row.diagnostic_json !== null) {
    try {
      const parsed = JSON.parse(row.diagnostic_json) as { message?: unknown };
      diagnostic = typeof parsed.message === "string" ? parsed.message : row.diagnostic_json;
    } catch {
      diagnostic = row.diagnostic_json;
    }
  }
  return {
    id: row.id,
    root: row.root,
    state: stateResult.success ? stateResult.data : "recovery_required",
    files: manifest?.files ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    diagnostic,
    manifestError,
  };
}
