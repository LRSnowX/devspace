import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { appendAuthorizationControls } from "./authorization-controls.js";

// Minimal DOM test adapter. Tests execute the production button creation and
// click handlers; no copied decision policy or additional browser dependency.
class TestElement {
  children: TestElement[] = [];
  textContent = "";
  type = "";
  disabled = false;
  private clickHandler?: () => Promise<void>;
  ownerDocument = { createElement: (tag: string) => new TestElement(tag) };
  constructor(readonly tag: string) {}
  append(child: TestElement) {
    this.children.push(child);
  }
  querySelectorAll() {
    return this.children.filter((child) => child.tag === "button");
  }
  addEventListener(_event: string, handler: () => Promise<void>) {
    this.clickHandler = handler;
  }
  async click() {
    if (!this.disabled) await this.clickHandler?.();
  }
}

const now = Date.parse("2026-10-04T00:00:00Z");
const request = {
  request_id: "a".repeat(64),
  workspace: "/work/project",
  requested_access: "modify" as const,
  expires_at: new Date(now + 120_000).toISOString(),
};
function render(
  app: Pick<App, "callServerTool"> | null,
  access: "inspect" | "modify" = "modify",
  time = now,
) {
  const section = new TestElement("section");
  appendAuthorizationControls(
    section as unknown as HTMLElement,
    { ...request, requested_access: access },
    app,
    time,
  );
  return { section, buttons: section.querySelectorAll() };
}

test("fresh modify controls render enabled without Host capability advertisements and call the App API", async () => {
  for (const decision of ["inspect", "modify", "deny"] as const) {
    const calls: unknown[] = [];
    // Representative usable App with no hostContext.capabilities/serverTools.
    const app = {
      callServerTool: async (args: unknown): Promise<CallToolResult> => {
        calls.push(args);
        return {
          content: [],
          structuredContent: {
            status: decision === "deny" ? "denied" : "approved",
          },
        };
      },
    };
    const { section, buttons } = render(app);
    assert.deepEqual(
      buttons.map((button) => [button.textContent, button.disabled]),
      [
        ["Inspect", false],
        ["Modify", false],
        ["Deny", false],
      ],
    );
    await buttons[["inspect", "modify", "deny"].indexOf(decision)].click();
    assert.deepEqual(calls, [
      {
        name: "approve_workspace_access",
        arguments: { request_id: request.request_id, decision },
      },
    ]);
    assert.ok(buttons.every((button) => button.disabled));
    assert.match(
      section.children.at(-1)!.textContent,
      decision === "deny" ? /denied/ : /approved/,
    );
  }
});

test("inspect keeps Modify unavailable and expiry disables every decision", async () => {
  let calls = 0;
  const app = {
    callServerTool: async (): Promise<CallToolResult> => {
      calls++;
      return { content: [] };
    },
  };
  const inspect = render(app, "inspect");
  assert.deepEqual(
    inspect.buttons.map((button) => button.disabled),
    [false, true, false],
  );
  await inspect.buttons[1].click();
  const expired = render(app, "modify", now + 120_000);
  assert.ok(expired.buttons.every((button) => button.disabled));
  for (const button of expired.buttons) await button.click();
  assert.equal(calls, 0);
});

test("transport failure, tool error, malformed response and missing App never imply approval", async () => {
  for (const response of [
    "throw",
    "tool-error",
    "domain-error",
    "malformed",
    "no-app",
  ] as const) {
    const app =
      response === "no-app"
        ? null
        : {
            callServerTool: async (): Promise<CallToolResult> => {
              if (response === "throw")
                throw new Error("Host cannot proxy tool calls");
              return {
                content: [],
                ...(response === "tool-error" ? { isError: true } : {}),
                structuredContent:
                  response === "malformed"
                    ? {}
                    : {
                        status:
                          response === "domain-error" ? "error" : "approved",
                        result: "Workspace access approved.",
                      },
              };
            },
          };
    const { section, buttons } = render(app);
    await buttons[0].click();
    const message = section.children.at(-1)!.textContent;
    assert.match(message, /could not be confirmed through the Host/);
    assert.match(message, /No approval is confirmed/);
    assert.doesNotMatch(message, /Workspace access approved/);
    assert.ok(buttons.every((button) => button.disabled));
  }
});
