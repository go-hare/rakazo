/**
 * claude 用 --permission-prompt-tool 拉起的 MCP。stdout 是 MCP 通道，不能打日志。
 * 每一问转给 daemon 的 broker socket，等窗口的答案。
 */
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

const socketPath = process.argv[3] ?? "";
const waiting = new Map<string, (answer: BrokerAnswer) => void>();
let live: Socket | null = null;

interface BrokerAnswer {
  behavior?: string;
  message?: string;
  always?: boolean;
}

function open(): Promise<Socket | null> {
  return new Promise((resolve) => {
    const conn = connect(socketPath);
    conn.setEncoding("utf8");
    let buffer = "";
    let connected = false;
    conn.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        const answer = parseAnswer(line);
        const finish = answer ? waiting.get(answer.id) : undefined;
        if (!answer || !finish) continue;
        waiting.delete(answer.id);
        finish(answer);
      }
    });
    conn.once("connect", () => {
      connected = true;
      live = conn;
      resolve(conn);
    });
    conn.on("error", () => {});
    conn.once("close", () => {
      if (live === conn) live = null;
      if (!connected) resolve(null);
      for (const [id, finish] of waiting) {
        waiting.delete(id);
        finish({ behavior: "deny", message: "审批服务断了" });
      }
    });
  });
}

function parseAnswer(line: string): (BrokerAnswer & { id: string }) | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const answer = parsed as Record<string, unknown>;
    if (answer.t !== "answer" || typeof answer.id !== "string") return null;
    return {
      id: answer.id,
      behavior: typeof answer.behavior === "string" ? answer.behavior : undefined,
      message: typeof answer.message === "string" ? answer.message : undefined,
      always: answer.always === true,
    };
  } catch {
    return null;
  }
}

async function askBroker(ask: Record<string, unknown> & { id: string }): Promise<BrokerAnswer> {
  const conn = live ?? await open();
  if (!conn) return { behavior: "deny", message: "审批服务没连上" };
  return new Promise((resolve) => {
    waiting.set(ask.id, resolve);
    conn.write(`${JSON.stringify(ask)}\n`);
  });
}

const TOOLS = [
  {
    name: "approve",
    description: "Ask the OpenMausBot user whether a tool use is allowed",
    inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" } }, required: ["tool_name", "input"] },
  },
  {
    name: "ask_user",
    description: "Ask the human who owns this bot a question and wait for their answer.",
    inputSchema: { type: "object", properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" } } }, required: ["question"] },
  },
];

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function handle(message: Record<string, unknown>): Promise<void> {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "openmausbot-permissions", version: "1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === "tools/call") {
    const params = message.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const args = params?.arguments ?? {};
    const nativeQuestion = params?.name === "approve" && args.tool_name === "AskUserQuestion";
    const question = params?.name === "ask_user" || nativeQuestion;
    const answer = await askBroker({
      t: "ask",
      id: randomUUID(),
      kind: question ? "question" : "permission",
      tool: question ? "ask_user" : args.tool_name,
      input: question ? args.input ?? { question: args.question, choices: args.choices } : args.input,
    });
    const suggestions = Array.isArray(args.permission_suggestions) ? args.permission_suggestions : undefined;
    const allowed: { behavior: "allow"; updatedInput: unknown; updatedPermissions?: unknown[] } = { behavior: "allow", updatedInput: args.input ?? {} };
    if (answer.always && suggestions) allowed.updatedPermissions = suggestions;
    const text = nativeQuestion
      ? JSON.stringify(answer.behavior === "deny"
        ? { behavior: "deny", message: answer.message || "拒绝了" }
        : { behavior: "allow", updatedInput: { ...(args.input as object ?? {}), answers: answer.message ? { [(args.input as { questions?: Array<{ question?: string }> } | undefined)?.questions?.[0]?.question ?? ""]: answer.message } : {} } })
      : question
        ? answer.message || "没有回答"
        : JSON.stringify(answer.behavior === "allow" ? allowed : { behavior: "deny", message: answer.message || "拒绝了" });
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], ...(question && answer.behavior === "deny" ? { isError: true } : {}) } });
    return;
  }
  if (typeof message.method === "string" && message.method.startsWith("notifications/")) return;
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) continue;
    try {
      void handle(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // 坏行丢掉。
    }
  }
});
process.stdin.on("end", () => process.exit(0));
