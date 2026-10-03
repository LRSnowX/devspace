import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export async function startOwnershipChild(
  t: TestContext,
  role: string,
  stateDir: string,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const child = fork(
    fileURLToPath(new URL("./write-ownership-child.ts", import.meta.url)),
    [role, stateDir, root],
    {
      execArgv: ["--import", "tsx"],
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });
  try {
    await childMessage(child);
  } catch (error) {
    throw new Error(stderr, { cause: error });
  }
  return child;
}

export async function childMessage(
  child: ChildProcess,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Fixture IPC timeout"));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", exited);
    };
    const message = (value: unknown) => {
      cleanup();
      resolve(value as Record<string, unknown>);
    };
    const exited = () => {
      cleanup();
      reject(new Error("Fixture exited before IPC result"));
    };
    child.once("message", message);
    child.once("exit", exited);
  });
}
