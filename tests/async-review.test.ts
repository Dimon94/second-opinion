import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, it, expect } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { ReviewStore, type ReviewRecord } from "../src/session/reviews.js";
import { writeSession } from "../src/session/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

describe("async review wakeup", () => {
  it("denies completion with read-only OAuth and advertises the write consent contract", async () => {
    const state=isolateStateDir(),root=makeTmpDir("review-consent");
    let queued=0;
    const bridge=await startBridge({workspaceRoot:root,port:0,persistRuntime:false,reviewQueue:async()=>{queued++;}});
    const registration=bridge.authStore.registerClient({clientName:"read-only",redirectUris:["https://chatgpt.com/oauth/callback"],baseUrl:bridge.localBaseUrl()});
    const access=bridge.authStore.issueTokens({identity:bridge.authStore.identityForClient(bridge.localBaseUrl(),registration.clientId,["workspace.read"])!}).accessToken;
    const client=new Client({name:"read-only",version:"1"});
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.localBaseUrl()+"/mcp/session"),{requestInit:{headers:{authorization:`Bearer ${access}`}}}));
      const host=randomUUID(),principal={clientId:registration.clientId,scopes:["workspace.read"]};
      const binding=bridge.bindings.redeem(bridge.bindings.mint(root,host).bootstrapToken,principal,"remote-read");
      writeSession(new Workspace(root).id,{url:`https://chatgpt.com/c/${host}`,taskId:"read-test",iteration:1,lastState:"INIT",savedAt:new Date().toISOString()},host);
      const record=new ReviewStore().local("arm",root,host)!;
      const response=await client.callTool({name:"complete_review",arguments:{binding_token:binding.binding_token,review_id:record.id,result:"review"},_meta:{"openai/session":"remote-read"}});
      expect(response.isError).toBe(true);
      expect(response._meta?.["mcp/www_authenticate"]).toEqual([expect.stringContaining('scope="workspace.read review.submit"')]);
      expect(queued).toBe(0);
      expect(new ReviewStore().local("status",root,host)?.status).toBe("armed");
      const tool=(await client.listTools()).tools.find(t=>t.name==="complete_review")!;
      expect(tool.annotations).toMatchObject({readOnlyHint:false,destructiveHint:true});
      expect(tool._meta?.securitySchemes).toEqual([{type:"oauth2",scopes:["workspace.read","review.submit"]}]);
      const metadata=await (await fetch(bridge.localBaseUrl()+"/.well-known/oauth-protected-resource/mcp")).json();
      expect(metadata.scopes_supported).toContain("review.submit");
    } finally {await client.close();await bridge.close();[state,root].forEach(cleanup);delete process.env.C2C_STATE_DIR;}
  });
  it("allows repairing a missing real queue executable without stranding the review", async () => {
    const state=isolateStateDir(),root=makeTmpDir("review-executable"),host=randomUUID();
    const old=process.env.C2C_CODEX_BIN;
    try {
      process.env.C2C_CODEX_BIN=path.join(state,"missing-codex");
      writeSession(new Workspace(root).id,{url:"https://chatgpt.com/c/test_chat",taskId:"task",iteration:1,lastState:"INIT",savedAt:new Date().toISOString()},host);
      const directory=path.join(state,"reviews"),reviews=new ReviewStore(directory);
      const a=reviews.local("arm",root,host)!;
      const taskHash=createHash("sha256").update(host).digest("hex");
      await expect(reviews.complete(root,taskHash,a.id,"review")).rejects.toThrow("WAKE_EXECUTABLE_UNAVAILABLE");
      expect(reviews.local("status",root,host)?.status).toBe("armed");
      let count=0;
      const repaired=new ReviewStore(directory,async()=>{count++;});
      await repaired.complete(root,taskHash,a.id,"review");
      expect(count).toBe(1);
      repaired.local("ack",root,host,a.id);
      const b=repaired.local("arm",root,host)!;
      const owner=createHash("sha256").update(root+"\0"+taskHash).digest("hex");
      fs.writeFileSync(path.join(directory,owner+".json."+b.id+".dispatch"),"",{flag:"wx"});
      await expect(repaired.complete(root,taskHash,b.id,"review")).rejects.toThrow("WAKE_DELIVERY_UNCERTAIN");
      expect(count).toBe(1);
    } finally {
      if(old===undefined) delete process.env.C2C_CODEX_BIN; else process.env.C2C_CODEX_BIN=old;
      [state,root].forEach(cleanup);delete process.env.C2C_STATE_DIR;
    }
  });

  it("routes authenticated HTTP completion to the locally armed host once, then permits a second round", async () => {
    const state = isolateStateDir(), root = makeTmpDir("review-project");
    const sent: ReviewRecord[] = [];
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, reviewQueue: async r => { sent.push({...r}); } });
    const registration = bridge.authStore.registerClient({clientName:"review-test",redirectUris:["https://chatgpt.com/oauth/callback"],baseUrl:bridge.localBaseUrl()});
    const access = bridge.authStore.issueTokens({identity:bridge.authStore.identityForClient(bridge.localBaseUrl(),registration.clientId,["workspace.read","review.submit"])!}).accessToken;
    const client = new Client({name:"review-test",version:"1"});
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.localBaseUrl()+"/mcp/session"),{requestInit:{headers:{authorization:`Bearer ${access}`}}}));
    const hosts=[randomUUID(),randomUUID()];
    const principal={clientId:registration.clientId,scopes:["workspace.read","review.submit"]};
    const tokens=hosts.map((host,i)=>bridge.bindings.redeem(bridge.bindings.mint(root,host).bootstrapToken,principal,`remote-${i}`).binding_token);
    const save=(i:number,iteration:number)=>writeSession(new Workspace(root).id,{url:`https://chatgpt.com/c/${hosts[i]}`,taskId:`task-${i}`,iteration,lastState:"INIT",savedAt:new Date().toISOString()},hosts[i]);
    const local=async(action:string,i:number,id?:string)=>{
      const response=await fetch(bridge.localBaseUrl()+"/admin/reviews",{method:"POST",headers:{authorization:`Bearer ${bridge.adminToken}`,"content-type":"application/json"},body:JSON.stringify({action,taskId:hosts[i],workspaceRoot:root,id})});
      return {status:response.status,body:await response.json() as {review:ReviewRecord}};
    };
    const complete=(i:number,id:string,session=`remote-${i}`)=>client.callTool({name:"complete_review",arguments:{binding_token:tokens[i],review_id:id,result:"Independent analysis based on project evidence."},_meta:{"openai/session":session}});
    try {
      save(0,1); save(1,1);
      const a=(await local("arm",0)).body.review, b=(await local("arm",1)).body.review;
      expect((await local("arm",0)).status).toBe(400);
      expect((await complete(1,a.id)).isError).toBe(true);
      expect((await complete(0,a.id,"remote-1")).isError).toBe(true);
      expect(sent).toHaveLength(0);
      expect((await complete(0,a.id)).isError).not.toBe(true);
      expect((await complete(0,a.id)).isError).not.toBe(true);
      expect(sent.map(r=>r.hostTaskId)).toEqual([hosts[0]]);
      await local("ack",0,a.id); save(0,2);
      const a2=(await local("arm",0)).body.review;
      expect((await complete(0,a.id)).isError).toBe(true);
      expect((await complete(0,a2.id)).isError).not.toBe(true);
      expect(sent.map(r=>r.iteration)).toEqual([1,2]);
      await local("cancel",1,b.id);
      expect((await complete(1,b.id)).isError).toBe(true);
      bridge.bindings.unbindTask(hosts[0],root);
      expect((await complete(0,a2.id)).isError).toBe(true);
      const tools=await client.listTools();
      expect(tools.tools.find(t=>t.name==="complete_review")?.annotations?.readOnlyHint).toBe(false);
    } finally { await client.close();await bridge.close();[state,root].forEach(cleanup);delete process.env.C2C_STATE_DIR; }
  });

  it("persists uncertain delivery without automatic duplicate dispatch; rejects stale saved round", async () => {
    const state=isolateStateDir(),root=makeTmpDir("review-recovery"),host=randomUUID();
    const taskHash=createHash("sha256").update(host).digest("hex");
    const workspace=new Workspace(root);
    const saved={url:`https://chatgpt.com/c/${host}`,taskId:"task",iteration:1,lastState:"INIT",savedAt:new Date().toISOString()};
    let count=0;
    const directory=path.join(state,"reviews");
    try {
      writeSession(workspace.id,saved,host);
      const reviews=new ReviewStore(directory,async()=>{count++;throw new Error("timeout");});
      const a=reviews.local("arm",root,host)!;
      await expect(reviews.complete(root,taskHash,a.id,"review")).rejects.toThrow("WAKE_DELIVERY_UNCERTAIN");
      const restarted=new ReviewStore(directory,async()=>{count++;});
      await expect(restarted.complete(root,taskHash,a.id,"review")).rejects.toThrow("WAKE_DELIVERY_UNCERTAIN");
      expect(count).toBe(1);
      expect(restarted.local("status",root,host)?.result).toBe("review");
      restarted.local("ack",root,host,a.id);
      const b=restarted.local("arm",root,host)!;
      writeSession(workspace.id,{...saved,iteration:2},host);
      await expect(restarted.complete(root,taskHash,b.id,"stale")).rejects.toThrow("REVIEW_MISMATCH");
      expect(count).toBe(1);
    } finally { [state,root].forEach(cleanup);delete process.env.C2C_STATE_DIR; }
  });
});
