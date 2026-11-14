import { expect, test } from "bun:test";
import { parseCloudFrame } from "./protocol.ts";

test("云端只给这一句话，多出来的历史字段丢掉", () => {
  const frame = parseCloudFrame(
    JSON.stringify({
      type: "turn",
      botId: "bot-1",
      threadId: "thread-1",
      turnId: "turn-1",
      text: "看一下这个目录",
      cwd: "D:/work/demo",
      history: [{ role: "user", text: "上一句" }],
    }),
  );
  expect(frame).toEqual({
    type: "turn",
    botId: "bot-1",
    threadId: "thread-1",
    turnId: "turn-1",
    text: "看一下这个目录",
    cwd: "D:/work/demo",
    agent: "claude",
    permission: "default",
  });
});

test("权限、模型、effort 和系统提示原样带上，不认识的权限丢掉", () => {
  const base = { type: "turn", botId: "b", threadId: "t", turnId: "u", text: "hi", cwd: "D:/work" };
  const frame = parseCloudFrame(
    JSON.stringify({
      ...base,
      permission: "auto",
      model: "opus",
      effort: "high",
      system: "你是助手",
    }),
  );
  expect(frame).toMatchObject({
    permission: "auto",
    model: "opus",
    effort: "high",
    system: "你是助手",
  });
  expect(parseCloudFrame(JSON.stringify({ ...base, permission: "yolo" }))).toBeNull();
});

test("云端指定拉起哪个 agent，不认识的丢掉", () => {
  const base = { type: "turn", botId: "b", threadId: "t", turnId: "u", text: "hi", cwd: "D:/work" };
  expect(agentOf(parseCloudFrame(JSON.stringify({ ...base, agent: "grok" })))).toBe("grok");
  expect(agentOf(parseCloudFrame(JSON.stringify({ ...base, agent: "codex" })))).toBe("codex");
  expect(parseCloudFrame(JSON.stringify({ ...base, agent: "gemini" }))).toBeNull();
});

function agentOf(frame: ReturnType<typeof parseCloudFrame>): string | null {
  return frame?.type === "turn" ? frame.agent : null;
}

test("缺字段或者不是 JSON 就丢掉", () => {
  expect(parseCloudFrame("{")).toBeNull();
  expect(parseCloudFrame(JSON.stringify({ type: "turn", text: "没有目录" }))).toBeNull();
  expect(parseCloudFrame(JSON.stringify({ type: "nope" }))).toBeNull();
});

test("审批答复必须绑定非空对话、轮次和请求", () => {
  const answer = {
    type: "answer",
    threadId: "t",
    turnId: "u",
    requestId: "r",
    behavior: "allow",
  } as const;
  expect(parseCloudFrame(JSON.stringify(answer))).toEqual(answer);
  expect(parseCloudFrame(JSON.stringify({ ...answer, turnId: undefined }))).toBeNull();
  expect(parseCloudFrame(JSON.stringify({ ...answer, turnId: "" }))).toBeNull();
  expect(parseCloudFrame(JSON.stringify({ ...answer, requestId: "" }))).toBeNull();
});

test("取消只认对话号和轮次号", () => {
  expect(parseCloudFrame(JSON.stringify({ type: "cancel", threadId: "t", turnId: "u" }))).toEqual({
    type: "cancel",
    threadId: "t",
    turnId: "u",
  });
});
