import path from "node:path";
import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { WorkspaceBindingStore } from "../src/session/bindings.js";
import { mergeSession, readSession, writeSession } from "../src/session/state.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach(cleanup);
  delete process.env.C2C_STATE_DIR;
});

it("keeps four owners isolated through recovery and rejects binding another owner to an occupied chat", () => {
  const state = isolateStateDir();
  const a = makeTmpDir("project-a");
  const b = makeTmpDir("project-b");
  dirs.push(state, a, b);
  const file = path.join(state, "bindings.json");
  let store = new WorkspaceBindingStore({ file });
  const principal = { clientId: "shared-connector", scopes: ["workspace.read"] };
  const lanes = [a, b, a, b].map((root, i) => {
    const owner = `host-${i}`;
    const remote = `chat-${i}`;
    const token = store.redeem(store.mint(root, owner).bootstrapToken, principal, remote).binding_token;
    const workspace = store.resolve(token, principal, remote);
    writeSession(workspace.id, mergeSession(null, {
      url: `https://chatgpt.com/c/${remote}`, taskId: `protocol-${i}`,
      checkpoint: { protocolState: "PLAN_RECEIVED", waitingFor: "none" },
    }), owner);
    return { root, owner, remote, token, id: workspace.id };
  });
  store = new WorkspaceBindingStore({ file });
  for (const lane of lanes) {
    expect(store.resolve(lane.token, principal, lane.remote).root).toBe(lane.root);
    expect(readSession(lane.id, lane.owner)?.checkpoint?.taskId).toBe(`protocol-${lanes.indexOf(lane)}`);
    for (const other of lanes.filter((other) => other !== lane)) {
      expect(() => store.resolve(lane.token, principal, other.remote)).toThrow(/session/);
    }
  }
  // Mis-targeting a tab must fail even for a sibling task in the SAME project.
  for (const wrongOwner of [lanes[1], lanes[2]]) {
    const bootstrap = store.mint(wrongOwner.root, wrongOwner.owner).bootstrapToken;
    expect(() => store.redeem(bootstrap, principal, lanes[0].remote)).toThrow(/already bound/);
    // A rejected target must not consume the single-use capability.
    expect(store.redeem(bootstrap, principal, wrongOwner.remote).binding_token).toBeTruthy();
  }
  store.unbindTask(lanes[0].owner, lanes[0].root);
  expect(() => store.resolve(lanes[0].token, principal, lanes[0].remote)).toThrow(/required/);
  expect(store.resolve(lanes[3].token, principal, lanes[3].remote).root).toBe(b);
});

it("refuses to save the same normalized chat URL for another local owner", () => {
  dirs.push(isolateStateDir());
  const session = mergeSession(null, { url: "https://chatgpt.com/c/shared-chat" });
  writeSession("project-a", session, "host-a");
  expect(() => writeSession("project-a", session, "host-a-prime")).toThrow(/another host task/);
  expect(() => writeSession("project-b", {
    ...session, url: "https://www.chatgpt.com/c/WEB:shared-chat/",
  }, "host-b")).toThrow(/another host task/);
  expect(readSession("project-a", "host-a")?.url).toBe(session.url);
  expect(readSession("project-a", "host-a-prime")).toBeNull();
});

it("fails closed when loading conflicting bindings created before the ownership guard", () => {
  const state = isolateStateDir();
  const root = makeTmpDir("legacy-binding-conflict");
  dirs.push(state, root);
  const file = path.join(state, "bindings.json");
  const store = new WorkspaceBindingStore({ file });
  const principal = { clientId: "shared", scopes: ["workspace.read"] };
  const first = store.redeem(store.mint(root, "a").bootstrapToken, principal, "chat-a");
  store.redeem(store.mint(root, "a-prime").bootstrapToken, principal, "chat-a-prime");
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  old.bindings[1].sessionHash = old.bindings[0].sessionHash;
  fs.writeFileSync(file, JSON.stringify(old));
  expect(() => new WorkspaceBindingStore({ file }).resolve(first.binding_token, principal, "chat-a"))
    .toThrow(/multiple local owners/);
});
