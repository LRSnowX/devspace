import type { App } from "@modelcontextprotocol/ext-apps";
import type { ToolResultCard } from "./card-types.js";

const FAILURE_MESSAGE =
  "Authorization could not be confirmed through the Host. No approval is confirmed. Retry open_workspace for a new request.";

// Host capability advertisements are optional. Attempt the supported App API;
// server-side request validation, not a UI capability flag, grants authority.
export function appendAuthorizationControls(
  section: HTMLElement,
  request: NonNullable<ToolResultCard["authorization"]>,
  app: Pick<App, "callServerTool"> | null,
  now = Date.now(),
): void {
  const expired = now >= Date.parse(request.expires_at);
  const message = (text: string) => {
    const paragraph = section.ownerDocument.createElement("p");
    paragraph.textContent = text;
    section.append(paragraph);
  };
  for (const decision of ["inspect", "modify", "deny"] as const) {
    const button = section.ownerDocument.createElement("button");
    button.type = "button";
    button.textContent = decision[0].toUpperCase() + decision.slice(1);
    button.disabled =
      expired ||
      (decision === "modify" && request.requested_access !== "modify");
    button.addEventListener("click", async () => {
      for (const control of section.querySelectorAll("button"))
        control.disabled = true;
      try {
        if (!app) throw new Error("App is unavailable.");
        const result = await app.callServerTool({
          name: "approve_workspace_access",
          arguments: { request_id: request.request_id, decision },
        });
        const structured = result.structuredContent;
        if (
          result.isError ||
          (structured?.status !== "approved" && structured?.status !== "denied")
        ) {
          message(FAILURE_MESSAGE);
          return;
        }
        message(
          typeof structured.result === "string"
            ? structured.result
            : structured.status === "approved"
              ? "Workspace access approved. Retry open_workspace to continue."
              : "Workspace access denied.",
        );
      } catch {
        message(FAILURE_MESSAGE);
      }
    });
    section.append(button);
  }
}
