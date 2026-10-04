import { join, resolve } from "node:path";
import type { ToolMode } from "./config-schema.js";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";
import type { SubagentsConfig } from "./local-agent-config.js";

export type { ToolMode } from "./config-schema.js";

export interface ServerConfig {
  configDir: string;
  projectRegistryPath: string;
  memory: MemoryAdapterConfig;
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  conversationAuthorizationEnabled: boolean;
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  uiEnabled: boolean;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: SubagentsConfig;
  agentDir: string;
  logging: LoggingConfig;
}

export interface MemoryAdapterConfig {
  enabled: boolean;
  command?: string;
  dataHome?: string;
  bootstrapTimeoutMs: number;
  bootstrapByteBudget: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const stored = files.config;
  const host = stored.server.host;
  const port = stored.server.port;
  const publicBaseUrl = parsePublicBaseUrl(
    stored.server.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...stored.server.allowedHosts,
  ];

  return {
    configDir: files.dir,
    projectRegistryPath: join(files.dir, "projects.json"),
    memory: {
      enabled: stored.memory.enabled,
      command: stored.memory.command ? normalizeCommand(stored.memory.command) : undefined,
      dataHome: stored.memory.dataHome ? normalizePath(stored.memory.dataHome) : undefined,
      bootstrapTimeoutMs: stored.memory.bootstrapTimeoutMs,
      bootstrapByteBudget: stored.memory.bootstrapByteBudget,
    },
    host,
    port,
    oauth: {
      ownerToken: parseRequiredSecret(
        env.DEVSPACE_OAUTH_OWNER_TOKEN ?? files.auth.ownerToken,
      ),
      accessTokenTtlSeconds: stored.oauth.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: stored.oauth.refreshTokenTtlSeconds,
      scopes: stored.oauth.scopes,
      allowedResourceUrls: stored.oauth.allowedResourceUrls,
      allowedRedirectHosts: stored.oauth.allowedRedirectHosts,
    },
    allowedRoots: normalizePaths(stored.workspaces.allowedRoots, [process.cwd()]),
    conversationAuthorizationEnabled: stored.workspaces.conversationAuthorization,
    allowedHosts: normalizeAllowedHosts(derivedAllowedHosts),
    publicBaseUrl,
    toolMode: stored.tools.mode,
    uiEnabled: stored.ui.enabled,
    stateDir: normalizePath(stored.storage.stateDir),
    worktreeRoot: normalizePath(stored.workspaces.worktreeRoot),
    artifactsEnabled: stored.artifacts.enabled,
    artifactMaxFileBytes: stored.artifacts.maxFileBytes,
    skillsEnabled: stored.skills.enabled,
    skillPaths: stored.skills.paths,
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents: stored.subagents,
    agentDir: normalizePath(stored.skills.agentDir),
    logging: {
      ...stored.logging,
      trustProxy: stored.server.trustProxy,
    },
  };
}

function normalizeCommand(command: string): string {
  return command.includes("/") || command.startsWith("~") ? normalizePath(command) : command;
}

function normalizePaths(paths: string[], fallback: string[] = []): string[] {
  return (paths.length > 0 ? paths : fallback).map(normalizePath);
}

function normalizePath(path: string): string {
  return resolve(expandHomePath(path));
}

function normalizeAllowedHosts(hosts: string[]): string[] {
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseRequiredSecret(value: string | undefined): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error("OAuth owner token is required. Run: devspace init");
  }
  if (secret.length < 16) {
    throw new Error("OAuth owner token must be at least 16 characters long.");
  }
  return secret;
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
