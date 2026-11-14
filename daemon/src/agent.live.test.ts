import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTurn, type AgentEmit } from "./agent.ts";
import { files } from "./paths.ts";
import type { AgentKind, DaemonFrame, LaunchOptions } from "./protocol.ts";

const options: LaunchOptions = {
  model: null, effort: null, permission: "bypassPermissions", system: null, volatile: null,
  tools: null, disallowedTools: null, settings: null, mcp: {}, toolScope: null, addDirs: [],
};

const home = await mkdtemp(path.join(os.tmpdir(), "rakazo-daemon-"));
process.env.RAKAZO_DAEMON_HOME = home;

test("同一个对话复用进程，换 agent 就换进程", async () => {
  process.env.RAKAZO_DAEMON_AGENT_CLAUDE = JSON.stringify([process.execPath, path.join(import.meta.dir, "fake-agent.ts"), "claude"]);
  process.env.RAKAZO_DAEMON_AGENT_GROK = JSON.stringify([process.execPath, path.join(import.meta.dir, "fake-agent.ts"), "grok"]);
  const frames: DaemonFrame[] = [];
  const emit: AgentEmit = (frame) => {
    frames.push(frame);
  };
  const cwd = os.tmpdir();
  await runTurn({ threadId: "t1", turnId: "u1", text: "第一句", cwd, agent: "claude", options, images: [] }, emit);
  await waitFor(() => frames.some((frame) => frame.type === "done" && frame.turnId === "u1"));
  await runTurn({ threadId: "t1", turnId: "u2", text: "第二句", cwd, agent: "claude", options, images: [] }, emit);
  await waitFor(() => frames.some((frame) => frame.type === "done" && frame.turnId === "u2"));
  await runTurn({ threadId: "t1", turnId: "u3", text: "换 grok", cwd, agent: "grok", options, images: [] }, emit);
  await waitFor(() => frames.some((frame) => frame.type === "done" && frame.turnId === "u3"));

  const text = frames.filter((frame) => frame.type === "delta").map((frame) => frame.text);
  expect(text).toEqual(["claude:第一句", "claude:第二句", "grok:换 grok"]);
  const sessions = await Bun.file(files.sessions()).json() as Record<string, string>;
  expect(sessions["claude:t1"]).toBe("claude-session");
  expect(sessions["grok:t1"]).toBe("grok-session");
});

async function waitFor(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !done(); attempt++) await Bun.sleep(20);
  expect(done()).toBe(true);
}

afterAll(async () => {
  const { cancelTurn } = await import("./agent.ts");
  cancelTurn("t1");
  await Bun.sleep(100);
  await rm(home, { recursive: true, force: true });
});

export type { AgentKind };
