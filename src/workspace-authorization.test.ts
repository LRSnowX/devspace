import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkspaceAuthorization,
  WORKSPACE_AUTHORIZATION_TTL_MS,
} from "./workspace-authorization.js";

test("authorization grants are conversation/target scoped, multi-target and process local", () => {
  const store = new WorkspaceAuthorization();
  for (const target of ["/project-a", "/project-b"]) {
    const request = store.request("chat-a", target, target, "modify");
    assert.match(request.request_id, /^[a-f0-9]{64}$/);
    assert.ok(!request.request_id.includes(target));
    store.decide(request.request_id, "chat-a", "modify");
    assert.equal(store.allows("chat-a", target, "inspect"), true);
    assert.equal(store.allows("chat-a", target, "modify"), true);
    assert.equal(store.allows("chat-b", target, "inspect"), false);
    assert.equal(
      new WorkspaceAuthorization().allows("chat-a", target, "inspect"),
      false,
    );
  }
});

test("requests fail closed on expiry, replay, mismatch, missing scope and escalation", () => {
  let now = 100;
  const store = new WorkspaceAuthorization(() => now);
  const expired = store.request("a", "/a", "A", "modify");
  now += WORKSPACE_AUTHORIZATION_TTL_MS;
  assert.throws(
    () => store.decide(expired.request_id, "a", "modify"),
    /expired/,
  );
  assert.equal(store.allows("a", "/a", "inspect"), false);
  const request = store.request("a", "/a", "A", "inspect");
  assert.throws(
    () => store.decide(request.request_id, "b", "inspect"),
    /unavailable/,
  );
  assert.throws(
    () => store.decide(request.request_id, undefined, "inspect"),
    /unavailable/,
  );
  store.decide(request.request_id, "a", "inspect");
  assert.equal(store.allows("a", "/a", "modify"), false);
  assert.throws(
    () => store.decide(request.request_id, "a", "modify"),
    /unavailable/,
  );
  const escalation = store.request("a", "/b", "B", "inspect");
  assert.throws(
    () => store.decide(escalation.request_id, "a", "modify"),
    /new request/,
  );
  assert.equal(store.allows("a", "/b", "modify"), false);
  const denied = store.request("a", "/b", "B", "modify");
  store.decide(denied.request_id, "a", "deny");
  assert.equal(store.allows("a", "/b", "inspect"), false);
  assert.throws(() => store.require("a", "/b", "modify"), /authorization/);
});

test("missing or unusable Host scope retains compatibility fallback", () => {
  const store = new WorkspaceAuthorization();
  for (const value of [
    undefined,
    null,
    {},
    { "openai/session": "" },
    { "openai/session": "  " },
    { "openai/session": 12 },
  ]) {
    assert.equal(store.scope(value), undefined);
  }
  assert.equal(
    store.scope({ "openai/session": "host-conversation" }),
    "host-conversation",
  );
});
