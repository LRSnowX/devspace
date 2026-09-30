export type PatchTransactionState =
  | "preparing"
  | "prepared"
  | "committing"
  | "committed"
  | "recovery_required";

export type PatchFileState =
  | { kind: "absent" }
  | { kind: "present"; revision: string; mode?: number };

export interface PatchTransactionFile {
  /** Workspace-relative target path. */
  path: string;
  original: PatchFileState;
  published: PatchFileState;
  /** Workspace-relative, same-directory transaction-owned paths. */
  finalPath?: string;
  recoveryPath?: string;
  replacementBackupPath?: string;
  recoveryReplacementBackupPath?: string;
}

export interface PatchTransactionManifest {
  id: string;
  /** Canonical workspace root, independent of workspace_id lifetime. */
  root: string;
  files: PatchTransactionFile[];
}

export interface PatchTransactionRecord extends PatchTransactionManifest {
  state: PatchTransactionState;
  createdAt: string;
  updatedAt: string;
  diagnostic?: string;
  manifestError?: string;
}

export interface PatchTransactionJournal {
  assertRootWritable(root: string): void;
  createPreparing(manifest: PatchTransactionManifest): void;
  markPrepared(id: string): void;
  markCommitting(id: string): void;
  markCommitted(id: string): void;
  markRecoveryRequired(id: string, diagnostic: string): void;
  delete(id: string): void;
}
