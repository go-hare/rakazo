import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, LaunchPlan } from "./agents.ts";
import {
  approvalReply,
  createSession,
  launchArgs,
  launchCommand,
  openSession,
  readEvent,
  spokenAnswer,
  writePrompt,
} from "./agents.ts";
import type { Broker } from "./broker.ts";
import { openBroker } from "./broker.ts";
import type {
  AgentKind,
  AskFrame,
  DeltaFrame,
  DoneFrame,
  ImageFrame,
  LaunchOptions,
  PresentationFrame,
  TeamFrame,
  ToolFrame,
  TurnImage,
  UsageFrame,
} from "./protocol.ts";
import { launchKey } from "./protocol.ts";
import { readSessions, rememberSession, sessionKey } from "./sessions.ts";

export interface AgentTurn {
  threadId: string;
  turnId: string;
  text: string;
  cwd: string;
  agent: AgentKind;
  options: LaunchOptions;
  images: TurnImage[];
}

interface LineQueue {
  push(line: Record<string, unknown>): Promise<void>;
  fail(error: Error): void;
  next(): Promise<Record<string, unknown>>;
  handoff(to: (line: Record<string, unknown>) => Promise<void>): void;
}

interface LiveAgent {
  threadId: string;
  kind: AgentKind;
  process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  cwd: string;
  /** 权限、模型、系统提示变了就换进程。 */
  launch: string;
  tempDirs: string[];
  broker: Broker | null;
  /** codex / grok 的审批请求，等窗口的答案。 */
  asks: Map<
    string,
    {
      requestId: number;
      allow: unknown;
      deny: unknown;
      kind: "permission" | "question";
      questions: Array<{ id: string }>;
    }
  >;
  /** 正在跑的那一轮。stdout 的字都算在它头上。 */
  turnId: string;
  settled: boolean;
  session: AgentSession;
  opening: Promise<void> | null;
  emit: AgentEmit | null;
  stderr: string;
  lines: LineQueue;
  team: Map<string, (result: { ok: boolean; text: string }) => void>;
}

const live = new Map<string, LiveAgent>();
const OPEN_TIMEOUT_MS = 30_000;

export type AgentEmit = (
  frame:
    | DeltaFrame
    | DoneFrame
    | AskFrame
    | ToolFrame
    | UsageFrame
    | ImageFrame
    | PresentationFrame
    | TeamFrame,
) => void;

/**
 * 一个对话留一个 agent 进程。还在、目录没变、还是同一个 agent，就只往 stdin 再写这一句；
 * 否则重新拉起。本机有会话 id 时，claude 带 --resume，codex / grok 用自己的恢复请求。
 * 上下文从这台电脑自己的存储装回来。
 */
export async function runTurn(
  turn: AgentTurn,
  emit: AgentEmit,
  signal?: AbortSignal,
): Promise<void> {
  let agent = live.get(turn.threadId) ?? null;
  try {
    const key = launchKey(turn.options);
    if (
      !agent ||
      agent.kind !== turn.agent ||
      agent.cwd !== turn.cwd ||
      agent.launch !== key ||
      agent.process.exitCode !== null
    ) {
      if (agent) retire(agent);
      agent = await spawnAgent(turn);
      if (signal?.aborted) {
        retire(agent);
        return;
      }
      live.set(turn.threadId, agent);
      void read(agent, emit);
      const opening = agent;
      opening.opening = open(opening).finally(() => {
        opening.opening = null;
      });
    }
    for (const [id, finish] of agent.team) {
      agent.team.delete(id);
      finish({ ok: false, text: "Turn ended" });
    }
    agent.asks.clear();
    agent.emit = emit;
    agent.turnId = turn.turnId;
    agent.settled = false;
    agent.session.nextId++;
    await agent.opening;
    if (signal?.aborted) {
      retire(agent);
      return;
    }
    const current = agent;
    writePrompt(
      current.session,
      {
        write: (value) => writeLine(current, value),
        read: () => Promise.reject(new Error("发消息时不读 stdout")),
      },
      { text: turn.text, images: turn.images, steer: false },
    );
  } catch (error) {
    if (agent) retire(agent);
    emit(
      done(
        turn.threadId,
        turn.turnId,
        false,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

/** 窗口对一条审批的回答。claude 走本机代理，codex 和 grok 写回那条 JSON-RPC。 */
export function answerTurn(
  threadId: string,
  turnId: string,
  requestId: string,
  behavior: "allow" | "deny" | "answer",
  message?: string,
): boolean {
  const agent = live.get(threadId);
  if (!agent || agent.settled || agent.turnId !== turnId) return false;
  if (agent.broker?.answer(requestId, { behavior, message })) return true;
  const ask = agent.asks.get(requestId);
  if (
    !ask ||
    (ask.kind === "permission"
      ? behavior === "answer"
      : behavior === "allow" || (behavior === "answer" && !message?.trim()))
  )
    return false;
  agent.asks.delete(requestId);
  const spoken =
    behavior === "answer" && ask.kind === "question" && message
      ? spokenAnswer(agent.kind === "grok" ? "grok" : "codex", message, ask.questions)
      : undefined;
  writeLine(agent, approvalReply(ask.requestId, behavior, spoken ?? ask.allow, ask.deny, spoken));
  return true;
}

/** 正在跑的一轮里再插一句。codex 走 turn/steer，不换进程。 */
export function steerTurn(threadId: string, text: string): boolean {
  const agent = live.get(threadId);
  if (!agent || agent.settled) return false;
  writePrompt(
    agent.session,
    {
      write: (value) => writeLine(agent, value),
      read: () => Promise.reject(new Error("steer 不读 stdout")),
    },
    { text, images: [], steer: true },
  );
  return true;
}

export function cancelAllTurns(): void {
  for (const agent of live.values()) if (!agent.settled) retire(agent);
}

export function cancelTurn(threadId: string, turnId?: string): boolean {
  const agent = live.get(threadId);
  if (!agent || agent.settled || (turnId && agent.turnId !== turnId)) return false;
  retire(agent);
  return true;
}

async function open(agent: LiveAgent): Promise<void> {
  const sessionId = await openSession(
    agent.session,
    {
      write: (value) => writeLine(agent, value),
      read: () => agent.lines.next(),
    },
    agent.cwd,
  );
  if (sessionId) await rememberSession(sessionKey(agent.kind, agent.threadId), sessionId);
  agent.lines.handoff((line) => onLine(agent, line));
}

async function spawnAgent(turn: AgentTurn): Promise<LiveAgent> {
  const sessions = await readSessions();
  const saved = sessions[sessionKey(turn.agent, turn.threadId)] ?? null;
  const broker =
    turn.options.permission === "bypassPermissions"
      ? null
      : await openBroker(
          (ask) => {
            const current = live.get(turn.threadId);
            current?.emit?.({
              type: "ask",
              threadId: turn.threadId,
              turnId: current.turnId,
              ...ask,
            });
          },
          (itemId, presentation) => {
            const current = live.get(turn.threadId);
            if (!current || current.settled) throw new Error("No active turn");
            current.emit?.({
              type: "presentation",
              threadId: turn.threadId,
              turnId: current.turnId,
              itemId,
              presentation,
            });
          },
          (tool, input) => requestTeam(turn.threadId, tool, input),
        );
  const plan = launchPlan(turn, saved, broker?.socketPath ?? null);
  let child: LiveAgent["process"];
  try {
    child = Bun.spawn({
      cmd: [...launchCommand(turn.agent), ...launchArgs(turn.agent, plan)],
      cwd: turn.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        ...(process.env.RAKAZO_DAEMON_ENGINE_HOME
          ? { HOME: process.env.RAKAZO_DAEMON_ENGINE_HOME }
          : {}),
      },
    });
  } catch (error) {
    broker?.close();
    if (plan.systemFile) rmSync(join(plan.systemFile, ".."), { recursive: true, force: true });
    if (plan.mcpFile) rmSync(join(plan.mcpFile, ".."), { recursive: true, force: true });
    throw error;
  }
  return {
    threadId: turn.threadId,
    kind: turn.agent,
    process: child,
    cwd: turn.cwd,
    launch: launchKey(turn.options),
    tempDirs: [plan.systemFile, plan.settingsFile, plan.mcpFile].flatMap((file) =>
      file ? [join(file, "..")] : [],
    ),
    broker,
    asks: new Map(),
    turnId: turn.turnId,
    settled: false,
    session: createSession(turn.agent, plan.sessionId, turn.options),
    opening: null,
    emit: null,
    stderr: "",
    lines: lineQueue(turn.agent),
    team: new Map(),
  };
}

const TEAM_TIMEOUT_MS = 45_000;

function requestTeam(
  threadId: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  const agent = live.get(threadId);
  if (!agent || agent.settled || !agent.emit) {
    return Promise.resolve({ ok: false, message: "No active turn" });
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!agent.team.delete(requestId)) return;
      resolve({ ok: false, message: "Team action timed out" });
    }, TEAM_TIMEOUT_MS);
    agent.team.set(requestId, (result) => {
      clearTimeout(timer);
      resolve({ ok: result.ok, message: result.text });
    });
    agent.emit?.({
      type: "team",
      threadId: agent.threadId,
      turnId: agent.turnId,
      requestId,
      tool,
      input,
    });
  });
}

export function completeTeam(
  threadId: string,
  requestId: string,
  ok: boolean,
  text: string,
): boolean {
  const agent = live.get(threadId);
  const pending = agent?.team.get(requestId);
  if (!pending) return false;
  agent.team.delete(requestId);
  pending({ ok, text });
  return true;
}

async function read(agent: LiveAgent, emit: AgentEmit): Promise<void> {
  agent.emit = emit;
  void drainStderr(agent);
  const reader = agent.process.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const parsed = parseLine(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (parsed) await agent.lines.push(parsed);
      }
    }
  } finally {
    agent.lines.fail(new Error(`${agent.kind} 退出了`));
    for (const [id, finish] of agent.team) {
      agent.team.delete(id);
      finish({ ok: false, text: `${agent.kind} 退出了` });
    }
    agent.broker?.close();
    removeSystem(agent);
    if (live.get(agent.threadId) === agent) {
      live.delete(agent.threadId);
      // 还在握手时，失败从 opening 抛出去，这里不再报一次。
      if (!agent.settled && !agent.opening) {
        const detail = agent.stderr.trim();
        emit(
          done(
            agent.threadId,
            agent.turnId,
            false,
            detail ? `${agent.kind} 退出了：${detail}` : `${agent.kind} 退出了`,
          ),
        );
      }
    }
  }
}

async function onLine(agent: LiveAgent, line: Record<string, unknown>): Promise<void> {
  const content = (line.message as { content?: unknown } | undefined)?.content;
  if (
    agent.kind === "claude" &&
    line.type === "user" &&
    Array.isArray(content) &&
    content.length > 1
  ) {
    for (const block of content)
      await onLine(agent, { ...line, message: { ...(line.message as object), content: [block] } });
    return;
  }
  const event = readEvent(agent.session, line);
  if (!event || !agent.emit) return;
  if (event.type === "session") {
    agent.session.sessionId = event.sessionId;
    await rememberSession(sessionKey(agent.kind, agent.threadId), event.sessionId);
    return;
  }
  if (event.type === "ask") {
    const requestId = crypto.randomUUID();
    agent.asks.set(requestId, {
      requestId: event.requestId,
      allow: event.allow,
      deny: event.deny,
      kind: event.kind,
      questions: event.questions ?? [],
    });
    agent.emit({
      type: "ask",
      threadId: agent.threadId,
      turnId: agent.turnId,
      requestId,
      kind: event.kind,
      tool: event.tool,
      summary: event.summary,
      ...(event.command ? { command: event.command } : {}),
      ...(event.cwd ? { cwd: event.cwd } : {}),
    });
    return;
  }
  if (event.type === "delta") {
    agent.emit({
      type: "delta",
      threadId: agent.threadId,
      turnId: agent.turnId,
      text: event.text,
      ...(event.kind === "reasoning" ? { kind: "reasoning" } : {}),
    });
    return;
  }
  if (event.type === "tool") {
    agent.emit({
      type: "tool",
      threadId: agent.threadId,
      turnId: agent.turnId,
      itemId: event.itemId,
      title: event.title,
      phase: event.phase,
      ...(event.ok !== undefined ? { ok: event.ok } : {}),
    });
    return;
  }
  if (event.type === "image") {
    agent.emit({
      type: "image",
      threadId: agent.threadId,
      turnId: agent.turnId,
      mime: event.mime,
      data: event.data,
    });
    return;
  }
  if (event.type === "usage") {
    agent.emit({
      type: "usage",
      threadId: agent.threadId,
      turnId: agent.turnId,
      input: event.input,
      output: event.output,
    });
    return;
  }
  agent.settled = true;
  agent.asks.clear();
  agent.broker?.denyAll("Turn ended");
  agent.emit(done(agent.threadId, agent.turnId, event.ok, event.error));
}

function lineQueue(kind: AgentKind): LineQueue {
  const buffer: Record<string, unknown>[] = [];
  let waiting: ((result: Record<string, unknown> | Error) => void) | null = null;
  let turned: ((line: Record<string, unknown>) => Promise<void>) | null = null;
  return {
    async push(line) {
      if (turned) return turned(line);
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(line);
        return;
      }
      buffer.push(line);
    },
    fail(error) {
      if (!waiting) return;
      const resolve = waiting;
      waiting = null;
      resolve(error);
    },
    next() {
      const queued = buffer.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = null;
          reject(new Error(`${kind} 没有响应`));
        }, OPEN_TIMEOUT_MS);
        waiting = (result) => {
          clearTimeout(timer);
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
      });
    },
    handoff(to) {
      turned = to;
      const pending = buffer.splice(0);
      void (async () => {
        for (const line of pending) await to(line);
      })();
    },
  };
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeLine(agent: LiveAgent, value: unknown): void {
  agent.process.stdin.write(`${JSON.stringify(value)}\n`);
  void agent.process.stdin.flush();
}

function launchPlan(
  turn: AgentTurn,
  saved: string | null,
  brokerSocket: string | null,
): LaunchPlan {
  const systemFile =
    turn.agent === "claude" && turn.options.system
      ? writeTemp("rakazo-system-", "prompt.txt", turn.options.system)
      : null;
  const settingsFile =
    turn.agent === "claude" && turn.options.settings
      ? writeTemp("rakazo-settings-", "settings.json", JSON.stringify(turn.options.settings))
      : null;
  const mcpFile =
    turn.agent === "claude" && (brokerSocket || Object.keys(scopedServers(turn.options)).length)
      ? writeMcp(scopedServers(turn.options), brokerSocket)
      : null;
  const base = {
    resume: Boolean(saved),
    systemFile,
    settingsFile,
    mcpFile,
    brokerSocket,
    options: turn.options,
  };
  if (turn.agent !== "claude") return { ...base, sessionId: saved };
  return { ...base, sessionId: saved ?? crypto.randomUUID() };
}

function scopedServers(options: LaunchOptions): LaunchOptions["mcp"] {
  if (!options.toolScope) return options.mcp;
  const allow = new Set(options.toolScope);
  return Object.fromEntries(Object.entries(options.mcp).filter(([name]) => allow.has(name)));
}

function writeMcp(servers: LaunchOptions["mcp"], brokerSocket: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "rakazo-mcp-"));
  const file = join(dir, "mcp.json");
  const broker = brokerSocket
    ? { command: process.execPath, args: [...proxyArgs(), "--permission-proxy", brokerSocket] }
    : undefined;
  writeFileSync(
    file,
    JSON.stringify({ mcpServers: { ...servers, ...(broker ? { rakazo: broker } : {}) } }),
  );
  return file;
}

/** 编译成单个 exe 之后没有脚本路径，参数就是 --permission-proxy。 */
function proxyArgs(): string[] {
  const entry = process.argv[1];
  return entry && entry !== "--permission-proxy" && !entry.endsWith(".exe") ? [entry] : [];
}

function writeTemp(prefix: string, name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const file = join(dir, name);
  writeFileSync(file, contents);
  return file;
}

/** 服务端在 Windows 上用 taskkill /T。只杀 agent 会留下它拉起的 MCP。 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  else process.kill(pid);
}

function retire(agent: LiveAgent): void {
  agent.settled = true;
  for (const [id, finish] of agent.team) {
    agent.team.delete(id);
    finish({ ok: false, text: "Turn ended" });
  }
  if (live.get(agent.threadId) === agent) live.delete(agent.threadId);
  killTree(agent.process.pid);
  agent.broker?.close();
  removeSystem(agent);
}

function removeSystem(agent: LiveAgent): void {
  for (const dir of agent.tempDirs) rmSync(dir, { recursive: true, force: true });
  agent.tempDirs = [];
}

async function drainStderr(agent: LiveAgent): Promise<void> {
  const reader = agent.process.stderr.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    agent.stderr = `${agent.stderr}${decoder.decode(chunk.value, { stream: true })}`.slice(-500);
  }
}

function done(threadId: string, turnId: string, ok: boolean, error?: string): DoneFrame {
  return { type: "done", threadId, turnId, ok, ...(error ? { error } : {}) };
}
