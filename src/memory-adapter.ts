import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { MemoryAdapterConfig } from "./config.js";

const MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_recent",
  "memory_get_thread",
  "memory_project_context",
] as const;

export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export class MemoryAdapter {
  constructor(private readonly config: MemoryAdapterConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  async call(toolName: MemoryToolName, args: Record<string, unknown>) {
    if (!this.config.enabled || !this.config.command) {
      throw new Error("DevSpace memory adapter is disabled");
    }
    const env: Record<string, string> = {
      RUST_LOG: "warn,rmcp=warn,reqwest=warn",
    };
    if (this.config.dataHome) {
      env.CHAT_HISTORY_DATA_HOME = this.config.dataHome;
    }
    const transport = new StdioClientTransport({
      command: this.config.command,
      env,
      stderr: "inherit",
    });
    const client = new Client({ name: "devspace-memory-adapter", version: "1.0.0" });
    try {
      await client.connect(transport);
      const rawResult = await client.callTool({ name: toolName, arguments: args });
      return CallToolResultSchema.parse(rawResult);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

export function isMemoryToolName(value: string): value is MemoryToolName {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(value);
}
