import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { assertAllowedPath, expandHomePath } from "./roots.js";

export interface ProjectRegistration {
  name: string;
  path: string;
  aliases: string[];
}

export interface ProjectResolution {
  project: ProjectRegistration;
  registered: boolean;
}

export type ProjectLookup =
  | { status: "found"; resolution: ProjectResolution }
  | { status: "unknown" }
  | { status: "ambiguous"; paths: string[] };

interface ProjectRegistryFile {
  version: 1;
  projects: ProjectRegistration[];
}

function normalizeProjectKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s._-]+/gu, "");
}

function normalizeAliases(values: readonly string[] | undefined, name: string): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  const canonical = normalizeProjectKey(name);
  for (const raw of values ?? []) {
    const alias = raw.trim();
    const key = normalizeProjectKey(alias);
    if (!alias || !key || key === canonical || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

export class ProjectRegistry {
  private projects: ProjectRegistration[];

  constructor(
    private readonly filePath: string,
    private readonly allowedRoots: readonly string[],
  ) {
    this.projects = this.load();
  }

  list(): ProjectRegistration[] {
    return this.projects.map((project) => ({
      ...project,
      aliases: [...project.aliases],
    }));
  }

  resolve(project: string): ProjectRegistration | undefined {
    const key = normalizeProjectKey(project);
    if (!key) return undefined;
    return this.projects.find((entry) => this.keysFor(entry).includes(key));
  }

  lookup(project: string): ProjectLookup {
    const registered = this.resolve(project);
    if (registered) {
      return {
        status: "found",
        resolution: { project: registered, registered: true },
      };
    }

    const key = normalizeProjectKey(project);
    if (!key) return { status: "unknown" };
    const matches: string[] = [];
    for (const root of this.allowedRoots) {
      if (!existsSync(root)) continue;
      const rootPath = resolve(root);
      const rootName = normalizeProjectKey(rootPath.split(/[\\/]/u).at(-1) ?? "");
      if (rootName === key && statSync(rootPath).isDirectory()) matches.push(rootPath);
      for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
        if (normalizeProjectKey(entry.name) !== key) continue;
        const candidate = resolve(rootPath, entry.name);
        if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(candidate).isDirectory())) {
          matches.push(assertAllowedPath(candidate, [...this.allowedRoots]));
        }
      }
    }
    const unique = [...new Set(matches.map((value) => resolve(value)))];
    if (unique.length === 0) return { status: "unknown" };
    if (unique.length > 1) return { status: "ambiguous", paths: unique.sort() };
    return {
      status: "found",
      resolution: {
        project: {
          name: unique[0]!.split(/[\\/]/u).at(-1) ?? project.trim(),
          path: unique[0]!,
          aliases: [],
        },
        registered: false,
      },
    };
  }

  resolveOrDiscover(project: string): ProjectResolution | undefined {
    const lookup = this.lookup(project);
    return lookup.status === "found" ? lookup.resolution : undefined;
  }

  projectNameForPath(projectPath: string): string | undefined {
    const resolvedPath = resolve(expandHomePath(projectPath));
    return this.projects.find((entry) => resolve(entry.path) === resolvedPath)?.name;
  }

  register(input: {
    name: string;
    path: string;
    aliases?: readonly string[];
  }): ProjectRegistration {
    const name = input.name.trim();
    const key = normalizeProjectKey(name);
    if (!name || !key) throw new Error("Project name must not be empty");

    const projectPath = assertAllowedPath(input.path, [...this.allowedRoots]);
    if (!existsSync(projectPath)) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }
    if (!statSync(projectPath).isDirectory()) {
      throw new Error(`Project path is not a directory: ${projectPath}`);
    }

    const aliases = normalizeAliases(input.aliases, name);
    const incomingKeys = new Set([key, ...aliases.map(normalizeProjectKey)]);
    for (const existing of this.projects) {
      if (resolve(existing.path) === resolve(projectPath)) continue;
      if (this.keysFor(existing).some((existingKey) => incomingKeys.has(existingKey))) {
        throw new Error(
          `Project name or alias conflicts with registered project ${existing.name}`,
        );
      }
    }

    const registration = { name, path: projectPath, aliases };
    const samePathIndex = this.projects.findIndex(
      (entry) => resolve(entry.path) === resolve(projectPath),
    );
    if (samePathIndex >= 0) {
      this.projects[samePathIndex] = registration;
    } else {
      this.projects.push(registration);
    }
    this.projects.sort((left, right) => left.name.localeCompare(right.name));
    this.persist();
    return { ...registration, aliases: [...aliases] };
  }

  private keysFor(project: ProjectRegistration): string[] {
    return [project.name, ...project.aliases].map(normalizeProjectKey);
  }

  private load(): ProjectRegistration[] {
    if (!existsSync(this.filePath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read project registry ${this.filePath}: ${reason}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Invalid project registry: ${this.filePath}`);
    }
    const file = parsed as Partial<ProjectRegistryFile>;
    if (file.version !== 1 || !Array.isArray(file.projects)) {
      throw new Error(`Unsupported project registry format: ${this.filePath}`);
    }
    const projects: ProjectRegistration[] = [];
    for (const value of file.projects) {
      if (!value || typeof value !== "object") {
        throw new Error(`Invalid project registry entry: ${this.filePath}`);
      }
      const entry = value as Partial<ProjectRegistration>;
      if (typeof entry.name !== "string" || typeof entry.path !== "string") {
        throw new Error(`Invalid project registry entry: ${this.filePath}`);
      }
      const projectPath = assertAllowedPath(entry.path, [...this.allowedRoots]);
      const aliases = Array.isArray(entry.aliases)
        ? entry.aliases.filter((alias): alias is string => typeof alias === "string")
        : [];
      projects.push({
        name: entry.name.trim(),
        path: projectPath,
        aliases: normalizeAliases(aliases, entry.name),
      });
    }
    return projects;
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const staged = `${this.filePath}.${process.pid}.tmp`;
    const file: ProjectRegistryFile = { version: 1, projects: this.projects };
    writeFileSync(staged, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(staged, this.filePath);
  }
}
