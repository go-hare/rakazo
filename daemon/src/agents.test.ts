import { expect, test } from "bun:test";
import type { AgentIo, LaunchPlan } from "./agents.ts";
import { createSession, launchArgs, readEvent, writePrompt } from "./agents.ts";
import type { LaunchOptions } from "./protocol.ts";

const options: LaunchOptions = {
  model: null,
  effort: null,
  permission: "default",
  system: null,
  volatile: null,
  tools: null,
  disallowedTools: null,
  settings: null,
  mcp: {},
  toolScope: null,
  addDirs: [],
};

function plan(over: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    sessionId: null,
    resume: false,
    systemFile: null,
    settingsFile: null,
    mcpFile: null,
    brokerSocket: null,
    options,
    ...over,
  };
}

test("claude 带权限、模型、系统提示，有会话就 --resume，没有就 --session-id", () => {
  const fresh = launchArgs("claude", plan({ sessionId: "new-1" }));
  expect(fresh).toContain("--permission-mode");
  expect(fresh).toContain("default");
  expect(fresh).toContain("--session-id");
  expect(fresh).toContain("--replay-user-messages");
  expect(fresh).toContain("--system-prompt-snapshot");
  expect(fresh).not.toContain("--resume");
  const resumed = launchArgs(
    "claude",
    plan({
      sessionId: "sess-1",
      resume: true,
      systemFile: "D:/tmp/prompt.txt",
      options: {
        ...options,
        model: "opus",
        effort: "high",
        permission: "acceptEdits",
        system: "你是助手",
      },
    }),
  );
  expect(resumed).toContain("--resume");
  expect(resumed).toContain("--model");
  expect(resumed).toContain("--append-system-prompt-file");
  const asking = launchArgs(
    "claude",
    plan({
      sessionId: "new-1",
      mcpFile: "D:/tmp/mcp.json",
      brokerSocket: "D:/tmp/perm.sock",
      options: { ...options, mcp: { computer: { command: "cua" } } },
    }),
  );
  expect(asking).toContain("--mcp-config");
  expect(asking).toContain("--strict-mcp-config");
  expect(asking).toContain("--permission-prompt-tool");
  expect(asking).toContain("mcp__computer,mcp__rakazo");
});

test("codex 只拉 app-server，grok 的模型和 effort 夹在 agent 和 stdio 之间", () => {
  expect(launchArgs("codex", plan())).toEqual(["app-server"]);
  expect(
    launchArgs(
      "grok",
      plan({ options: { ...options, model: "grok-4.7", effort: "high", permission: "auto" } }),
    ),
  ).toEqual([
    "--permission-mode",
    "auto",
    "agent",
    "-m",
    "grok-4.7",
    "--reasoning-effort",
    "high",
    "stdio",
  ]);
});

test("claude 只写一句，会话 id 从 init 来", () => {
  const sent: unknown[] = [];
  const io: AgentIo = {
    write: (value) => sent.push(value),
    read: () => Promise.reject(new Error("claude 不握手")),
  };
  const session = createSession("claude", "sess-1", options);
  writePrompt(session, io, { text: "看一下", images: [], steer: false });
  expect(sent).toEqual([{ type: "user", message: { role: "user", content: "看一下" } }]);
  expect(readEvent(session, { type: "system", subtype: "init", session_id: "sess-2" })).toEqual({
    type: "session",
    sessionId: "sess-2",
  });
  expect(
    readEvent(session, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "好" } },
    }),
  ).toEqual({ type: "delta", text: "好", kind: "text" });
  expect(readEvent(session, { type: "result" })).toEqual({ type: "done", ok: true });
});

test("codex 恢复旧会话再发 turn/start，完成看 turn/completed", async () => {
  const sent: Array<{ id?: number; method: string; params: Record<string, unknown> }> = [];
  const replies = [
    { id: 1, result: {} },
    { id: 2, result: { config: { features: { shell_snapshot: false } } } },
    { id: 3, result: { thread: { id: "thread-9" } } },
  ];
  const io: AgentIo = {
    write: (value) => sent.push(value as { method: string; params: Record<string, unknown> }),
    read: () => Promise.resolve(replies.shift()!),
  };
  const session = createSession("codex", "thread-9", {
    ...options,
    model: "gpt-5",
    system: "你是助手",
  });
  await expect(
    import("./agents.ts").then(({ openSession }) => openSession(session, io, "D:/work")),
  ).resolves.toBe("thread-9");
  expect(sent.map((line) => line.method)).toEqual([
    "initialize",
    "initialized",
    "config/read",
    "thread/resume",
  ]);
  expect(sent.at(-1)?.params).toMatchObject({
    threadId: "thread-9",
    model: "gpt-5",
    developerInstructions: "你是助手",
  });
  writePrompt(session, io, { text: "继续", images: [], steer: false });
  expect(sent.at(-1)?.method).toBe("turn/start");
  expect(
    readEvent(session, { method: "item/agentMessage/delta", params: { delta: "好" } }),
  ).toEqual({ type: "delta", text: "好", kind: "text" });
  expect(
    readEvent(session, { method: "turn/completed", params: { turn: { status: "completed" } } }),
  ).toEqual({ type: "done", ok: true });
});

test("泛权限和永久授权不能通过单次审批卡放行", () => {
  const codex = createSession("codex", "session", options);
  const broad = readEvent(codex, {
    id: 1,
    method: "item/permissions/requestApproval",
    params: { permissions: { network: { enabled: true } } },
  });
  expect(broad?.type === "ask" && broad.allow).toEqual({ permissions: {}, scope: "turn" });
  const grok = createSession("grok", "session", options);
  const permanent = readEvent(grok, {
    id: 2,
    method: "session/request_permission",
    params: { options: [{ kind: "allow_always", optionId: "permanent" }] },
  });
  expect(permanent?.type === "ask" && permanent.allow).toEqual({
    outcome: { outcome: "cancelled" },
  });
});

test("grok 没有旧会话就 session/new，回复结束看 session/prompt 的结果", async () => {
  const sent: Array<{ id?: number; method: string }> = [];
  const replies = [
    { id: 1, result: {} },
    { id: 2, result: { sessionId: "grok-1" } },
    { id: 3, result: {} },
  ];
  const io: AgentIo = {
    write: (value) => sent.push(value as { method: string }),
    read: () => Promise.resolve(replies.shift()!),
  };
  const session = createSession("grok", null, {
    ...options,
    model: "grok-4.7",
    system: "你是助手",
  });
  const { openSession } = await import("./agents.ts");
  await expect(openSession(session, io, "D:/work")).resolves.toBe("grok-1");
  expect(sent.map((line) => line.method)).toEqual([
    "initialize",
    "session/new",
    "session/set_model",
  ]);
  writePrompt(session, io, { text: "开始", images: [], steer: false });
  expect(
    readEvent(session, {
      method: "session/update",
      params: {
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "好" } },
      },
    }),
  ).toEqual({ type: "delta", text: "好", kind: "text" });
  expect(readEvent(session, { id: session.promptId, result: { stopReason: "end_turn" } })).toEqual({
    type: "done",
    ok: true,
  });
});
