import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectRegistry } from "./project-registry.js";

test("project registry persists canonical names and resolves aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-project-registry-"));
  const project = join(root, "jack-ios-app");
  const registryPath = join(root, ".devspace", "projects.json");
  mkdirSync(project, { recursive: true });

  try {
    const registry = new ProjectRegistry(registryPath, [root]);
    const registered = registry.register({
      name: "Jack",
      path: project,
      aliases: ["Jack助手", " jack ", "JACK"],
    });
    assert.equal(registered.name, "Jack");
    assert.deepEqual(registered.aliases, ["Jack助手"]);
    assert.equal(registry.resolve("jack")?.path, project);
    assert.equal(registry.resolve(" Jack助手 ")?.name, "Jack");
    assert.equal(registry.projectNameForPath(project), "Jack");

    const reloaded = new ProjectRegistry(registryPath, [root]);
    assert.equal(reloaded.resolve("JACK")?.path, project);
    assert.equal(reloaded.resolve("Jack助手")?.name, "Jack");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project registry rejects alias conflicts and paths outside allowed roots", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-project-registry-root-"));
  const outside = mkdtempSync(join(tmpdir(), "devspace-project-registry-outside-"));
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });

  try {
    const registry = new ProjectRegistry(join(root, "projects.json"), [root]);
    registry.register({ name: "Jack", path: first, aliases: ["J"] });
    assert.throws(
      () => registry.register({ name: "Other", path: second, aliases: ["j"] }),
      /conflicts with registered project Jack/,
    );
    assert.throws(
      () => registry.register({ name: "Outside", path: outside }),
      /outside allowed roots/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("project registry discovers a unique top-level directory without persisting it", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-project-discovery-"));
  const project = join(root, "Jack");
  mkdirSync(project, { recursive: true });

  try {
    const registry = new ProjectRegistry(join(root, ".devspace", "projects.json"), [root]);
    const resolution = registry.resolveOrDiscover("jack");
    assert.equal(resolution?.registered, false);
    assert.equal(resolution?.project.path, project);
    assert.equal(resolution?.project.name, "Jack");
    assert.equal(registry.list().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project registry reports ambiguous top-level directory names", () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "devspace-project-first-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "devspace-project-second-"));
  mkdirSync(join(firstRoot, "Arcos"));
  mkdirSync(join(secondRoot, "Arcos"));
  try {
    const registry = new ProjectRegistry(join(firstRoot, "projects.json"), [firstRoot, secondRoot]);
    const lookup = registry.lookup("arcos");
    assert.equal(lookup.status, "ambiguous");
    if (lookup.status === "ambiguous") assert.equal(lookup.paths.length, 2);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});
