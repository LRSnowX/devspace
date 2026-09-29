import { createHash } from "node:crypto";

export const FILE_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function fileRevision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
