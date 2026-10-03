import { spawn } from "node:child_process";
import {
  getShellConfig,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { terminateProcessTree } from "./process-platform.js";
import type { ProcessMutationLifecycle } from "./process-sessions.js";

/** Pi retains output formatting/truncation; this seam observes the real executor. */
export function ownedBashOperations(
  begin: () => ProcessMutationLifecycle,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error("aborted");
      const shell = getShellConfig();
      const fromStdin = shell.commandTransport === "stdin";
      const mutation = begin();
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          shell.shell,
          fromStdin ? shell.args : [...shell.args, command],
          {
            cwd,
            env,
            detached: process.platform !== "win32",
            windowsHide: true,
            stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          },
        );
      } catch (error) {
        mutation.finished();
        throw error;
      }
      let timedOut = false;
      let persistenceError: unknown;
      let timer: NodeJS.Timeout | undefined;
      const kill = () => {
        try {
          terminateProcessTree(child, "SIGKILL", process.platform !== "win32");
        } catch (error) {
          persistenceError ??= error;
        }
      };
      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          let idleTimer: NodeJS.Timeout | undefined;
          let exited = false;
          let code: number | null = null;
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            if (idleTimer) clearTimeout(idleTimer);
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (error) reject(error);
            else resolve(code);
          };
          // Match Pi's post-exit idle grace: do not hang on inherited quiet pipes,
          // or truncate descendants that are still producing output.
          const armIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => finish(), 100);
          };
          const data = (chunk: Buffer) => {
            onData(chunk);
            if (exited) armIdle();
          };
          child.stdout?.on("data", data);
          child.stderr?.on("data", data);
          child.on("error", (error) => {
            if (child.pid) {
              // An error after spawn (for example a failed kill) is not proof
              // of exit. Retain the activity until an actual terminal event.
              persistenceError ??= error;
            } else finish(error);
          });
          child.once("close", (exitCode) => {
            code = exitCode;
            finish();
          });
          child.once("exit", (exitCode) => {
            exited = true;
            code = exitCode;
            armIdle();
          });
          if (child.pid) {
            try {
              mutation.spawned(child.pid);
            } catch (error) {
              persistenceError = error;
              kill();
            }
          }
          if (fromStdin) {
            child.stdin?.on("error", () => {});
            child.stdin?.end(command);
          }
          if (timeout !== undefined)
            timer = setTimeout(() => {
              timedOut = true;
              kill();
            }, timeout * 1000);
          if (signal?.aborted) kill();
          else signal?.addEventListener("abort", kill, { once: true });
        });
        if (persistenceError) throw persistenceError;
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        mutation.finished();
      }
    },
  };
}
