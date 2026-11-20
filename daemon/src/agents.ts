import type { AgentKind, LaunchOptions } from "./protocol.ts";

export interface LaunchPlan {
  /** 已有会话就恢复；claude 没有旧会话时这是新的 --session-id。 */
  sessionId: string | null;
  resume: boolean;
  /** claude 的系统提示写在这个文件里，用 --append-system-prompt-file 传。 */
  systemFile: string | null;
  /** claude 的 --settings。 */
  settingsFile: string | null;
  /** claude 的 MCP 配置，里面有用户的服务器和本机审批代理。 */
  mcpFile: string | null;
  /** 审批代理的 socket。bypassPermissions 没有。 */
  brokerSocket: string | null;
  options: LaunchOptions;
}

/** 拉起参数。claude 用 --resume 或 --session-id；codex 和 grok 的会话在握手里恢复。 */
export function launchArgs(kind: AgentKind, plan: LaunchPlan): string[] {
  if (kind === "codex") return ["app-server", ...codexMcpArgs(scopedMcp(plan.options))];
  if (kind === "grok") {
    return [
      "--permission-mode",
      plan.options.permission,
      "agent",
      ...(plan.options.model ? ["-m", plan.options.model] : []),
      ...(plan.options.effort ? ["--reasoning-effort", plan.options.effort] : []),
      "stdio",
    ];
  }
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    plan.options.permission,
  ];
  if (plan.options.model) args.push("--model", plan.options.model);
  if (plan.options.effort) args.push("--effort", plan.options.effort);
  if (plan.options.tools) args.push("--tools", plan.options.tools.join(","));
  if (plan.options.disallowedTools)
    args.push("--disallowedTools", plan.options.disallowedTools.join(","));
  if (plan.systemFile) args.push("--append-system-prompt-file", plan.systemFile);
  if (plan.settingsFile) args.push("--settings", plan.settingsFile);
  args.push(
    "--replay-user-messages",
    "--setting-sources",
    "project",
    "--system-prompt-snapshot",
    "off",
    ...autocompactArgs(),
  );
  for (const dir of plan.options.addDirs ?? []) args.push("--add-dir", dir);
  if (plan.mcpFile) {
    args.push("--mcp-config", plan.mcpFile, "--strict-mcp-config");
    const allowed = Object.keys(scopedMcp(plan.options)).map((name) => `mcp__${name}`);
    if (plan.brokerSocket) allowed.push("mcp__rakazo");
    if (allowed.length) args.push("--allowedTools", allowed.join(","));
  }
  if (plan.brokerSocket) args.push("--permission-prompt-tool", "mcp__rakazo__approve");
  if (plan.resume && plan.sessionId) args.push("--resume", plan.sessionId);
  else if (plan.sessionId) args.push("--session-id", plan.sessionId);
  return args;
}

/** 测试可以换成假的可执行文件。普通使用就是 PATH 上的 claude / codex / grok。 */
export function launchCommand(kind: AgentKind): string[] {
  const raw = process.env[`RAKAZO_DAEMON_AGENT_${kind.toUpperCase()}`];
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((part) => typeof part === "string" && part.length > 0)
    )
      return parsed;
    throw new Error(`RAKAZO_DAEMON_AGENT_${kind.toUpperCase()} 不是命令`);
  }
  return [process.env[`RAKAZO_DAEMON_${kind.toUpperCase()}`] ?? kind];
}

export interface AgentIo {
  write(value: unknown): void;
  /** 下一条 stdout JSON。超时或者进程没了就抛。 */
  read(): Promise<Record<string, unknown>>;
}

export interface PromptInput {
  text: string;
  images: Array<{ mime: string; data: string }>;
  /** 正在跑的一轮里再插一句。codex 用 turn/steer，不新开一轮。 */
  steer: boolean;
}

export interface AgentSession {
  kind: AgentKind;
  sessionId: string | null;
  options: LaunchOptions;
  nextId: number;
  /** 这一轮发给 codex / grok 的请求号。claude 不用。 */
  promptId: number | null;
  /** codex 正在跑的那一轮，steer 用。 */
  nativeTurnId: string | null;
}

export function createSession(
  kind: AgentKind,
  sessionId: string | null,
  options: LaunchOptions,
): AgentSession {
  return { kind, sessionId, options, nextId: 1, promptId: null, nativeTurnId: null };
}

/** 进程刚拉起时握手。返回要记住的会话 id；claude 的 id 要等 stdout 里的 init。 */
export async function openSession(
  session: AgentSession,
  io: AgentIo,
  cwd: string,
): Promise<string | null> {
  if (session.kind === "claude") return session.sessionId;
  if (session.kind === "codex") return openCodex(session, io, cwd);
  return openGrok(session, io, cwd);
}

export function writePrompt(session: AgentSession, io: AgentIo, input: PromptInput): void {
  const text = withVolatile(input.text, session.options);
  if (session.kind === "claude") {
    io.write({
      type: "user",
      message: { role: "user", content: claudeContent(text, input.images) },
    });
    return;
  }
  if (!session.sessionId) throw new Error(`${session.kind} 没有会话`);
  const id = session.nextId++;
  session.promptId = id;
  if (session.kind === "codex") {
    if (input.steer && session.nativeTurnId) {
      io.write({
        jsonrpc: "2.0",
        id,
        method: "turn/steer",
        params: {
          threadId: session.sessionId,
          expectedTurnId: session.nativeTurnId,
          input: [{ type: "text", text }],
        },
      });
      return;
    }
    io.write({
      jsonrpc: "2.0",
      id,
      method: "turn/start",
      params: {
        threadId: session.sessionId,
        input: [
          { type: "text", text },
          ...input.images.map((image) => ({
            type: "image",
            url: `data:${image.mime};base64,${image.data}`,
          })),
        ],
        ...codexApproval(session.options.permission).turn,
        ...(session.options.effort ? { effort: session.options.effort } : {}),
      },
    });
    return;
  }
  const prompt = session.options.system ? `${session.options.system}\n\n${text}` : text;
  io.write({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: {
      sessionId: session.sessionId,
      prompt: [
        { type: "text", text: prompt },
        ...input.images.map((image) => ({ type: "image", data: image.data, mimeType: image.mime })),
      ],
    },
  });
}

function withVolatile(text: string, options: LaunchOptions): string {
  return options.volatile ? `${options.volatile}\n\n${text}` : text;
}

function claudeContent(
  text: string,
  images: PromptInput["images"],
): string | Array<Record<string, unknown>> {
  if (!images.length) return text;
  return [
    { type: "text", text },
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mime, data: image.data },
    })),
  ];
}

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "delta"; text: string; kind: "text" | "reasoning" }
  | { type: "tool"; itemId: string; title: string; phase: "started" | "completed"; ok?: boolean }
  | { type: "usage"; input: number; output: number }
  | { type: "image"; mime: string; data: string }
  | {
      type: "ask";
      requestId: number;
      kind: "permission" | "question";
      tool: string;
      summary: string;
      command?: string;
      cwd?: string;
      questions?: Array<{ id: string }>;
      allow: unknown;
      deny: unknown;
    }
  | { type: "done"; ok: boolean; error?: string };

/** 一轮已经开始之后的 stdout。握手期间的行不进这里。 */
export function readEvent(session: AgentSession, line: Record<string, unknown>): AgentEvent | null {
  if (session.kind === "claude") return claudeEvent(line);
  if (session.kind === "codex") return codexEvent(session, line);
  return grokEvent(session, line);
}

async function openCodex(session: AgentSession, io: AgentIo, cwd: string): Promise<string> {
  await request(session, io, "initialize", {
    clientInfo: { name: "openmausbot", title: "OpenMausBot", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  io.write({ jsonrpc: "2.0", method: "initialized", params: {} });
  const configured = await request(session, io, "config/read", { cwd, includeLayers: false });
  const snapshot = (configured.config as { features?: { shell_snapshot?: unknown } } | undefined)
    ?.features?.shell_snapshot;
  if (snapshot === true) throw new Error("Codex 没关掉 shell 快照，这句话没发");
  const method = session.sessionId ? "thread/resume" : "thread/start";
  const instructions = {
    ...codexApproval(session.options.permission).thread,
    ...(session.options.model ? { model: session.options.model } : {}),
    ...(session.options.system ? { developerInstructions: session.options.system } : {}),
  };
  const params = session.sessionId
    ? { threadId: session.sessionId, ...instructions }
    : { cwd, ephemeral: false, ...instructions };
  const result = await request(session, io, method, params);
  const threadId = threadIdOf(result) ?? session.sessionId;
  if (!threadId) throw new Error("codex 没有返回会话");
  session.sessionId = threadId;
  return threadId;
}

async function openGrok(session: AgentSession, io: AgentIo, cwd: string): Promise<string> {
  await request(session, io, "initialize", {
    protocolVersion: 1,
    clientInfo: { name: "openmausbot", version: "0.0.0" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  const method = session.sessionId ? "session/load" : "session/new";
  const mcpServers = Object.entries(scopedMcp(session.options)).map(([name, server]) => ({
    name,
    ...server,
  }));
  const params = session.sessionId
    ? { sessionId: session.sessionId, cwd, mcpServers }
    : { cwd, mcpServers };
  const result = await request(session, io, method, params);
  const sessionId = typeof result.sessionId === "string" ? result.sessionId : session.sessionId;
  if (!sessionId) throw new Error("grok 没有返回会话");
  session.sessionId = sessionId;
  if (session.options.model)
    await request(session, io, "session/set_model", { sessionId, modelId: session.options.model });
  return sessionId;
}

/** 服务端 mountMcpServer 的同一串 -c。远程 MCP 没有 command，Codex 挂不上就不发这句话。 */
export function codexMcpArgs(servers: LaunchOptions["mcp"]): string[] {
  const args: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!("command" in server)) throw new Error(`Codex 挂不上 ${name}，这句话没发`);
    const prefix = `mcp_servers.${name}`;
    args.push(
      "-c",
      `${prefix}.command=${JSON.stringify(server.command)}`,
      "-c",
      `${prefix}.args=${JSON.stringify(server.args ?? [])}`,
      "-c",
      `${prefix}.env_vars=${JSON.stringify(Object.keys(server.env ?? {}))}`,
    );
  }
  return args;
}

/** bot 勾选了工具范围时，名单以外的 MCP 不挂。 */
export function scopedMcp(options: LaunchOptions): LaunchOptions["mcp"] {
  if (!options.toolScope) return options.mcp;
  const allow = new Set(options.toolScope);
  return Object.fromEntries(Object.entries(options.mcp).filter(([name]) => allow.has(name)));
}

function autocompactArgs(): string[] {
  const raw = (process.env.RAKAZO_DAEMON_CLAUDE_AUTOCOMPACT ?? "").trim().toLowerCase();
  if (raw === "off") return [];
  if (raw === "auto") return ["--autocompact", "auto"];
  const parsed = raw ? Number(raw) : 200_000;
  const window =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(1_000_000, Math.max(100_000, Math.floor(parsed)))
      : 200_000;
  return ["--autocompact", String(window)];
}

/** 跟服务端 namedApprovalParams 一致。bypassPermissions 是 full，其余都要问。 */
function codexApproval(permission: LaunchOptions["permission"]): {
  thread: { approvalPolicy: string; approvalsReviewer: string; sandbox: string };
  turn: { approvalPolicy: string; approvalsReviewer: string; sandboxPolicy: { type: string } };
} {
  if (permission === "bypassPermissions") {
    return {
      thread: { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" },
      turn: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    };
  }
  const reviewer = permission === "auto" ? "auto_review" : "user";
  return {
    thread: {
      approvalPolicy: "on-request",
      approvalsReviewer: reviewer,
      sandbox: "workspace-write",
    },
    turn: {
      approvalPolicy: "on-request",
      approvalsReviewer: reviewer,
      sandboxPolicy: { type: "workspaceWrite" },
    },
  };
}

async function request(
  session: AgentSession,
  io: AgentIo,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  const id = session.nextId++;
  io.write({ jsonrpc: "2.0", id, method, params });
  for (;;) {
    const line = await io.read();
    if (line.id !== id) continue;
    if (line.error && typeof line.error === "object") {
      const message = (line.error as { message?: unknown }).message;
      throw new Error(typeof message === "string" ? message : `${session.kind} ${method} 失败`);
    }
    return line.result && typeof line.result === "object"
      ? (line.result as Record<string, unknown>)
      : {};
  }
}

function toolOf(method: string): string {
  if (method.includes("command") || method === "execCommandApproval") return "shell";
  if (method.includes("file") || method === "applyPatchApproval") return "edit";
  return "tool";
}

/** 窗口的答案写回 codex / grok 的那条审批请求。提问用窗口说的那句话，不用拉起时的空答案。 */
export function approvalReply(
  requestId: number,
  behavior: "allow" | "deny" | "answer",
  allow: unknown,
  deny: unknown,
  spoken?: unknown,
): Record<string, unknown> {
  const chosen = behavior === "deny" ? deny : (spoken ?? allow);
  return { jsonrpc: "2.0", id: requestId, result: chosen };
}

/** 一句回答对一个问题。多问时按行对齐，行数对不上就整句给第一问。 */
export function spokenAnswer(
  agent: "codex" | "grok",
  message: string,
  questions: Array<{ id: string }>,
): unknown {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const pick = (index: number) =>
    lines.length === questions.length ? (lines[index] ?? "") : index === 0 ? message : "";
  if (agent === "grok") {
    const answers: Record<string, string[]> = {};
    questions.forEach((question, index) => {
      const text = pick(index);
      if (text) answers[question.id] = [text];
    });
    return { outcome: "accepted", answers };
  }
  const answers: Record<string, { answers: string[] }> = {};
  questions.forEach((question, index) => {
    const text = pick(index);
    if (text) answers[question.id] = { answers: [text] };
  });
  return { answers };
}

function codexDecision(method: string, params: Record<string, unknown>, allow: boolean): unknown {
  if (method === "execCommandApproval" || method === "applyPatchApproval")
    return { decision: allow ? "approved" : "denied" };
  if (method === "item/permissions/requestApproval") {
    // A generic card cannot describe or authorize a broad permission grant.
    return { permissions: {}, scope: "turn" };
  }
  if (method === "item/tool/requestUserInput") return questionAnswers(params);
  if (method === "mcpServer/elicitation/request")
    return { action: allow ? "accept" : "decline", ...(allow ? { content: {} } : {}) };
  return { decision: allow ? "accept" : "decline" };
}

/** 还没人答的时候是空的。人的原话由 spokenAnswer 按问题 id 填。 */
function questionAnswers(_params: Record<string, unknown>): {
  answers: Record<string, { answers: string[] }>;
} {
  return { answers: {} };
}

function questionIds(params: Record<string, unknown>): Array<{ id: string }> {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return questions.flatMap((question) => {
    if (!question || typeof question !== "object") return [];
    const id = (question as { id?: unknown }).id;
    return typeof id === "string" ? [{ id }] : [];
  });
}

function threadIdOf(result: Record<string, unknown>): string | null {
  const thread = result.thread;
  if (!thread || typeof thread !== "object") return null;
  const id = (thread as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function imageOf(value: unknown): AgentEvent | null {
  if (!value || typeof value !== "object") return null;
  const block = value as {
    type?: string;
    content?: unknown;
    source?: { media_type?: string; data?: string };
    data?: string;
    mimeType?: string;
  };
  if (Array.isArray(block.content)) {
    for (const part of block.content) {
      const image = imageOf(part);
      if (image) return image;
    }
  }
  if (block.type !== "image") return null;
  const data = block.source?.data ?? block.data;
  if (typeof data !== "string" || !data) return null;
  return { type: "image", mime: block.source?.media_type ?? block.mimeType ?? "image/png", data };
}

function claudeEvent(line: Record<string, unknown>): AgentEvent | null {
  if (line.type === "user") {
    const content = (line.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      const result = content.find(
        (block) => block?.type === "tool_result" && typeof block.tool_use_id === "string",
      );
      if (result)
        return {
          type: "tool",
          itemId: result.tool_use_id,
          title: "tool",
          phase: "completed",
          ok: result.is_error !== true,
        };
    }
  }
  if (line.type === "system" && line.subtype === "init" && typeof line.session_id === "string") {
    return { type: "session", sessionId: line.session_id };
  }
  if (line.type === "result") {
    const ok = line.is_error !== true;
    return { type: "done", ok, ...(ok ? {} : { error: "claude 报错" }) };
  }
  const event = line.type === "stream_event" ? line.event : undefined;
  if (!event || typeof event !== "object") return imageOf(line.message);
  const started = (event as { content_block?: unknown }).content_block;
  if (
    (event as { type?: string }).type === "content_block_start" &&
    started &&
    typeof started === "object"
  ) {
    const tool = started as { type?: string; id?: string; name?: string };
    if (tool.type === "tool_use" && typeof tool.id === "string" && typeof tool.name === "string")
      return { type: "tool", itemId: tool.id, title: tool.name, phase: "started" };
  }
  const image = imageOf(started) ?? imageOf((event as { delta?: unknown }).delta);
  if (image) return image;
  const delta = (event as { delta?: { type?: string; text?: string }; type?: string }).delta;
  if (
    (event as { type?: string }).type === "content_block_delta" &&
    delta?.type === "text_delta" &&
    delta.text
  ) {
    return { type: "delta", text: delta.text, kind: "text" };
  }
  if (
    (event as { type?: string }).type === "content_block_delta" &&
    delta?.type === "thinking_delta" &&
    delta.text
  ) {
    return { type: "delta", text: delta.text, kind: "reasoning" };
  }
  return null;
}

const CODEX_APPROVALS = new Set([
  "execCommandApproval",
  "applyPatchApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
]);

function codexEvent(session: AgentSession, line: Record<string, unknown>): AgentEvent | null {
  if (
    typeof line.id === "number" &&
    typeof line.method === "string" &&
    (CODEX_APPROVALS.has(line.method) || line.method === "item/tool/requestUserInput")
  ) {
    const params =
      line.params && typeof line.params === "object"
        ? (line.params as Record<string, unknown>)
        : {};
    const elicitation = line.method === "mcpServer/elicitation/request";
    const toolCall =
      elicitation &&
      (params._meta as { codex_approval_kind?: string } | undefined)?.codex_approval_kind ===
        "mcp_tool_call";
    if (elicitation && !toolCall) {
      return {
        type: "ask",
        requestId: line.id,
        kind: "permission",
        tool: "mcp",
        summary: "MCP 征求的不是批准，已拒绝",
        allow: { action: "decline" },
        deny: { action: "decline" },
      };
    }
    const question = line.method === "item/tool/requestUserInput";
    const summary =
      typeof params.command === "string"
        ? params.command
        : typeof params.message === "string"
          ? params.message
          : typeof params.reason === "string"
            ? params.reason
            : line.method;
    return {
      type: "ask",
      requestId: line.id,
      kind: question ? "question" : "permission",
      tool: question ? "ask_user" : elicitation ? "mcp" : toolOf(line.method),
      summary,
      ...(typeof params.command === "string" ? { command: params.command } : {}),
      ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
      ...(question ? { questions: questionIds(params) } : {}),
      allow: question ? questionAnswers(params) : codexDecision(line.method, params, true),
      deny: question ? questionAnswers(params) : codexDecision(line.method, params, false),
    };
  }
  if (line.id === session.promptId && line.error)
    return { type: "done", ok: false, error: "codex 报错" };
  if (line.method === "item/agentMessage/delta" || line.method === "item/reasoning/textDelta") {
    const text = (line.params as { delta?: unknown } | undefined)?.delta;
    return typeof text === "string" && text
      ? {
          type: "delta",
          text,
          kind: line.method === "item/reasoning/textDelta" ? "reasoning" : "text",
        }
      : null;
  }
  if (line.method === "turn/started") {
    const id = (line.params as { turn?: { id?: unknown } } | undefined)?.turn?.id;
    if (typeof id === "string") session.nativeTurnId = id;
    return null;
  }
  if (line.method === "item/started" || line.method === "item/completed") {
    const item = (
      line.params as
        | {
            item?: {
              id?: unknown;
              type?: string;
              command?: unknown;
              text?: unknown;
              result?: unknown;
            };
          }
        | undefined
    )?.item;
    if (item?.type === "imageGeneration" && typeof item.result === "string" && item.result) {
      return { type: "image", mime: "image/png", data: item.result };
    }
    if (!item || typeof item.id !== "string") return null;
    const title = typeof item.command === "string" ? item.command : (item.type ?? "tool");
    return {
      type: "tool",
      itemId: item.id,
      title,
      phase: line.method === "item/started" ? "started" : "completed",
    };
  }
  if (line.method === "thread/tokenUsage/updated") {
    const total = (
      line.params as
        | { tokenUsage?: { total?: { inputTokens?: number; outputTokens?: number } } }
        | undefined
    )?.tokenUsage?.total;
    if (!total) return null;
    return { type: "usage", input: total.inputTokens ?? 0, output: total.outputTokens ?? 0 };
  }
  if (line.method === "turn/completed") {
    const turn = (line.params as { turn?: { status?: string } } | undefined)?.turn;
    const ok = turn?.status === "completed";
    return { type: "done", ok, ...(ok ? {} : { error: "codex 报错" }) };
  }
  return null;
}

const GROK_QUESTIONS = new Set(["_x.ai/ask_user_question", "x.ai/ask_user_question"]);

function grokEvent(session: AgentSession, line: Record<string, unknown>): AgentEvent | null {
  if (
    typeof line.id === "number" &&
    typeof line.method === "string" &&
    GROK_QUESTIONS.has(line.method)
  ) {
    const questions =
      (line.params as { questions?: Array<{ question?: string }> } | undefined)?.questions ?? [];
    const summary =
      questions
        .map((question) => question.question)
        .filter((text): text is string => typeof text === "string")
        .join(" · ") || "提问";
    const ids = questions.flatMap((question) =>
      typeof question.question === "string" ? [{ id: question.question }] : [],
    );
    return {
      type: "ask",
      requestId: line.id,
      kind: "question",
      tool: "ask_user",
      summary,
      questions: ids,
      allow: { outcome: "accepted", answers: {} },
      deny: { outcome: "cancelled" },
    };
  }
  if (line.method === "session/request_permission" && typeof line.id === "number") {
    const params =
      line.params && typeof line.params === "object"
        ? (line.params as { toolCall?: { title?: string; kind?: string } })
        : {};
    const call = params.toolCall;
    const options = Array.isArray((line.params as { options?: unknown } | undefined)?.options)
      ? (line.params as { options: Array<{ kind?: string; optionId?: string }> }).options
      : [];
    const option = (want: string) =>
      options.find((entry) => entry.kind === `${want}_once`)?.optionId;
    const selected = (id: string | undefined) =>
      id
        ? { outcome: { outcome: "selected", optionId: id } }
        : { outcome: { outcome: "cancelled" } };
    return {
      type: "ask",
      requestId: line.id,
      kind: "permission",
      tool: call?.kind === "execute" ? "shell" : call?.kind === "edit" ? "edit" : "tool",
      summary: call?.title ?? "tool",
      allow: selected(option("allow")),
      deny: selected(option("reject")),
    };
  }
  if (line.method === "session/update") {
    const update = (
      line.params as
        | {
            update?: {
              sessionUpdate?: string;
              content?: { type?: string; text?: string; data?: string; mimeType?: string };
            };
          }
        | undefined
    )?.update;
    if (update?.content?.type === "image" && update.content.data) {
      return {
        type: "image",
        mime: update.content.mimeType ?? "image/png",
        data: update.content.data,
      };
    }
    const text =
      update?.sessionUpdate === "agent_message_chunk" ||
      update?.sessionUpdate === "agent_thought_chunk"
        ? update.content?.text
        : undefined;
    if (typeof text === "string" && text)
      return {
        type: "delta",
        text,
        kind: update?.sessionUpdate === "agent_thought_chunk" ? "reasoning" : "text",
      };
    if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
      const call = update as { toolCallId?: unknown; title?: unknown; status?: unknown };
      if (typeof call.toolCallId !== "string") return null;
      const finished = call.status === "completed" || call.status === "failed";
      return {
        type: "tool",
        itemId: call.toolCallId,
        title: typeof call.title === "string" ? call.title : "tool",
        phase: finished ? "completed" : "started",
        ...(finished ? { ok: call.status === "completed" } : {}),
      };
    }
    return null;
  }
  if (line.id !== session.promptId) return null;
  if (line.error) return { type: "done", ok: false, error: "grok 报错" };
  const stop = (line.result as { stopReason?: unknown } | undefined)?.stopReason;
  const ok = stop !== "refusal";
  return { type: "done", ok, ...(ok ? {} : { error: "grok 拒绝了" }) };
}
