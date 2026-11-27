export const AGENT_KINDS = ["claude", "codex", "grok"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** 跟服务端的 approvalMode 对应。不写就是 default。 */
export const PERMISSIONS = ["default", "acceptEdits", "auto", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSIONS)[number];

/** MCP 服务器。stdio 是 command；远程是 url。跟服务端写进 --mcp-config 的是同一个形状。 */
export type McpServer =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };

/** 图片已经是 base64。daemon 不读云端的文件。 */
export interface TurnImage {
  mime: string;
  data: string;
}

export interface LaunchOptions {
  model: string | null;
  effort: string | null;
  permission: PermissionMode;
  /** 稳定的一半。claude 写进文件，codex 用 developerInstructions。 */
  system: string | null;
  /** 每轮都变的一半。跟在这句话后面，不进系统提示文件。 */
  volatile: string | null;
  tools: string[] | null;
  disallowedTools: string[] | null;
  /** claude 的 --settings。 */
  settings: Record<string, unknown> | null;
  mcp: Record<string, McpServer>;
  /** bot 勾选的 MCP 名字。不写就是全挂。 */
  toolScope: string[] | null;
  /** claude 的 --add-dir。 */
  addDirs: string[];
}

/** 云端发给本机。只有这一句话，没有历史。 */
export interface TurnFrame {
  type: "turn";
  commandId?: string;
  botId: string;
  threadId: string;
  turnId: string;
  text: string;
  /** bot 钉住的目录，就是 agent 的 cwd。 */
  cwd: string;
  /** 这一轮拉起哪个。不写就是 claude。 */
  agent: AgentKind;
  /** 不写就是 default。 */
  permission: PermissionMode;
  model?: string;
  effort?: string;
  /** claude 用文件传；codex 用 developerInstructions；grok 拼在这句话前面。 */
  system?: string;
  /** 每轮都变的一半，跟在这句话后面。 */
  volatile?: string;
  images?: TurnImage[];
  tools?: string[];
  disallowedTools?: string[];
  /** claude 的 --settings。 */
  settings?: Record<string, unknown>;
  /** 这一轮要挂上的 MCP。名字是挂载名。 */
  mcp?: Record<string, McpServer>;
  /** bot 勾选的 MCP 名字。不写就是全挂。名单以外的不挂。 */
  toolScope?: string[];
  /** claude 的 --add-dir。 */
  addDirs?: string[];
}

/** 正在跑的一轮里再插一句。进程不换。 */
export interface SteerFrame {
  type: "steer";
  threadId: string;
  turnId: string;
  text: string;
}

export interface CancelFrame {
  type: "cancel";
  commandId?: string;
  threadId: string;
  turnId: string;
}

export interface TeamResultFrame {
  type: "team_result";
  threadId: string;
  turnId: string;
  requestId: string;
  ok: boolean;
  text: string;
}

export type CloudFrame = TurnFrame | CancelFrame | AnswerFrame | SteerFrame | TeamResultFrame;

/** 本机发给云端。 */
export interface HelloFrame {
  type: "hello";
  name: string;
  protocolVersion?: number;
}

export interface DeltaFrame {
  type: "delta";
  threadId: string;
  turnId: string;
  text: string;
  /** 不写就是正文。reasoning 是思考。 */
  kind?: "text" | "reasoning";
}

/** 工具开始或结束。窗口用它画那一行。 */
export interface ToolFrame {
  type: "tool";
  threadId: string;
  turnId: string;
  itemId: string;
  title: string;
  phase: "started" | "completed";
  ok?: boolean;
}

/** 模型生成的图片。data 是 base64。 */
export interface ImageFrame {
  type: "image";
  threadId: string;
  turnId: string;
  mime: string;
  data: string;
}

export interface UsageFrame {
  type: "usage";
  threadId: string;
  turnId: string;
  input: number;
  output: number;
}

/** agent 要人批准。窗口答完之后云端发回 answer。 */
export interface AskFrame {
  type: "ask";
  threadId: string;
  turnId: string;
  requestId: string;
  kind: "permission" | "question";
  tool: string;
  summary: string;
  choices?: string[];
  command?: string;
  cwd?: string;
}

export interface AnswerFrame {
  type: "answer";
  commandId?: string;
  threadId: string;
  turnId: string;
  requestId: string;
  /** permission 用 allow / deny；question 用 answer。 */
  behavior: "allow" | "deny" | "answer";
  message?: string;
}

export interface DoneFrame {
  type: "done";
  threadId: string;
  turnId: string;
  ok: boolean;
  error?: string;
}

export interface PresentationFrame {
  type: "presentation";
  threadId: string;
  turnId: string;
  itemId: string;
  presentation: Record<string, unknown>;
}

export interface TeamFrame {
  type: "team";
  threadId: string;
  turnId: string;
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

export type DaemonFrame =
  | PresentationFrame
  | TeamFrame
  | HelloFrame
  | DeltaFrame
  | DoneFrame
  | AskFrame
  | ToolFrame
  | UsageFrame
  | ImageFrame
  | { type: "command_ack" | "command_rejected"; commandId: string };

export function parseCloudFrame(raw: string): CloudFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const frame = parsed as Record<string, unknown>;
  const commandId = optionalString(frame.commandId);
  if (
    commandId === null ||
    (commandId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commandId))
  )
    return null;
  const command = commandId ? { commandId } : {};
  const agent = agentOf(frame.agent);
  const permission = permissionOf(frame.permission);
  const model = optionalString(frame.model);
  const effort = optionalString(frame.effort);
  const system = optionalString(frame.system);
  const volatile = optionalString(frame.volatile);
  const mcp = mcpOf(frame.mcp);
  const images = imagesOf(frame.images);
  const tools = stringList(frame.tools);
  const disallowedTools = stringList(frame.disallowedTools);
  const settings = recordOf(frame.settings);
  const toolScope = stringList(frame.toolScope);
  const addDirs = stringList(frame.addDirs);
  if (
    frame.type === "turn" &&
    agent &&
    permission &&
    model !== null &&
    effort !== null &&
    system !== null &&
    volatile !== null &&
    mcp &&
    images &&
    tools !== null &&
    disallowedTools !== null &&
    settings !== null &&
    toolScope !== null &&
    addDirs !== null &&
    strings(frame, ["botId", "threadId", "turnId", "text", "cwd"])
  ) {
    return {
      type: "turn",
      ...command,
      botId: String(frame.botId),
      threadId: String(frame.threadId),
      turnId: String(frame.turnId),
      text: String(frame.text),
      cwd: String(frame.cwd),
      agent,
      permission,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(system ? { system } : {}),
      ...(volatile ? { volatile } : {}),
      ...(images.length ? { images } : {}),
      ...(tools ? { tools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
      ...(settings ? { settings } : {}),
      ...(Object.keys(mcp).length ? { mcp } : {}),
      ...(toolScope ? { toolScope } : {}),
      ...(addDirs ? { addDirs } : {}),
    };
  }
  if (frame.type === "steer" && strings(frame, ["threadId", "turnId", "text"])) {
    return {
      type: "steer",
      threadId: String(frame.threadId),
      turnId: String(frame.turnId),
      text: String(frame.text),
    };
  }
  if (
    frame.type === "answer" &&
    behaviorOf(frame.behavior) &&
    strings(frame, ["threadId", "turnId", "requestId"]) &&
    frame.threadId &&
    frame.turnId &&
    frame.requestId
  ) {
    const message = optionalString(frame.message);
    if (message === null) return null;
    return {
      type: "answer",
      ...command,
      threadId: String(frame.threadId),
      turnId: String(frame.turnId),
      requestId: String(frame.requestId),
      behavior: behaviorOf(frame.behavior)!,
      ...(message ? { message } : {}),
    };
  }
  if (frame.type === "cancel" && strings(frame, ["threadId", "turnId"])) {
    return {
      type: "cancel",
      ...command,
      threadId: String(frame.threadId),
      turnId: String(frame.turnId),
    };
  }
  if (
    frame.type === "team_result" &&
    strings(frame, ["threadId", "turnId", "requestId", "text"]) &&
    typeof frame.ok === "boolean"
  ) {
    return {
      type: "team_result",
      threadId: String(frame.threadId),
      turnId: String(frame.turnId),
      requestId: String(frame.requestId),
      ok: frame.ok,
      text: String(frame.text),
    };
  }
  return null;
}

function strings(frame: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof frame[key] === "string");
}

function agentOf(value: unknown): AgentKind | null {
  if (value === undefined) return "claude";
  return value === "claude" || value === "codex" || value === "grok" ? value : null;
}

function permissionOf(value: unknown): PermissionMode | null {
  if (value === undefined) return "default";
  return value === "default" ||
    value === "acceptEdits" ||
    value === "auto" ||
    value === "bypassPermissions"
    ? value
    : null;
}

/** 没写是没有；写了但不是字符串就丢掉整帧。空字符串当没写。 */
function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : undefined;
}

export function launchOptions(turn: {
  permission: PermissionMode;
  model?: string;
  effort?: string;
  system?: string;
  volatile?: string;
  tools?: string[];
  disallowedTools?: string[];
  settings?: Record<string, unknown>;
  mcp?: Record<string, McpServer>;
  toolScope?: string[];
  addDirs?: string[];
}): LaunchOptions {
  return {
    model: turn.model ?? null,
    effort: turn.effort ?? null,
    permission: turn.permission,
    system: turn.system ?? null,
    volatile: turn.volatile ?? null,
    tools: turn.tools ?? null,
    disallowedTools: turn.disallowedTools ?? null,
    settings: turn.settings ?? null,
    mcp: turn.mcp ?? {},
    toolScope: turn.toolScope ?? null,
    addDirs: turn.addDirs ?? [],
  };
}

/** 这些变了就要重新拉起。同一个进程换不了权限、模型或系统提示。 */
export function launchKey(options: LaunchOptions): string {
  return JSON.stringify(options);
}

function behaviorOf(value: unknown): AnswerFrame["behavior"] | null {
  return value === "allow" || value === "deny" || value === "answer" ? value : null;
}

function mcpOf(value: unknown): Record<string, McpServer> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const servers: Record<string, McpServer> = {};
  for (const [name, server] of Object.entries(value)) {
    const parsed = mcpServer(server);
    if (!parsed) return null;
    servers[name] = parsed;
  }
  return servers;
}

function mcpServer(value: unknown): McpServer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const env = stringMap(record.env);
  if (env === null) return null;
  if (typeof record.command === "string" && record.command) {
    if (
      record.args !== undefined &&
      !(Array.isArray(record.args) && record.args.every((arg) => typeof arg === "string"))
    )
      return null;
    return {
      command: record.command,
      ...(record.args ? { args: record.args as string[] } : {}),
      ...(env ? { env } : {}),
    };
  }
  if (typeof record.url === "string" && record.url) {
    const headers = stringMap(record.headers);
    if (headers === null) return null;
    return { url: record.url, ...(headers ? { headers } : {}) };
  }
  return null;
}

function imagesOf(value: unknown): TurnImage[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const images: TurnImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const image = item as Record<string, unknown>;
    if (typeof image.mime !== "string" || typeof image.data !== "string" || !image.data)
      return null;
    images.push({ mime: image.mime, data: image.data });
  }
  return images;
}

function stringList(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) return null;
  return value as string[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringMap(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}
