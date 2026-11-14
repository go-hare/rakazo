import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BrokerAsk {
  requestId: string;
  kind: "permission" | "question";
  tool: string;
  summary: string;
  command?: string;
  cwd?: string;
}

export interface BrokerAnswer {
  behavior: "allow" | "deny" | "answer";
  message?: string;
  /** 窗口勾了总是允许。claude 把 CLI 给的规则原样交回去。 */
  always?: boolean;
}

interface Pending {
  kind: BrokerAsk["kind"];
  finish(answer: BrokerAnswer): void;
}

/**
 * 跟服务端的 permission broker 一样：本机一个 socket，claude 的 MCP 代理连上来问。
 * 问出去的是 onAsk；窗口答完调 answer。
 */
export async function openBroker(onAsk: (ask: BrokerAsk) => void): Promise<Broker> {
  const dir = mkdtempSync(join(tmpdir(), "rakazo-perm-"));
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\rakazo-perm-${process.pid}-${Date.now()}`
      : join(dir, "perm.sock");
  const pending = new Map<string, Pending>();
  const server = createServer((conn) => accept(conn, pending, onAsk));
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(socketPath);
  });
  return {
    socketPath,
    answer(requestId, answer) {
      const ask = pending.get(requestId);
      if (
        !ask ||
        (ask.kind === "permission"
          ? answer.behavior === "answer"
          : answer.behavior === "allow" ||
            (answer.behavior === "answer" && !answer.message?.trim()))
      )
        return false;
      pending.delete(requestId);
      ask.finish(answer);
      return true;
    },
    denyAll(message) {
      for (const [id, ask] of pending) {
        pending.delete(id);
        ask.finish({ behavior: "deny", message });
      }
    },
    close() {
      for (const [id, ask] of pending) {
        pending.delete(id);
        ask.finish({ behavior: "deny", message: "daemon 停了" });
      }
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Broker {
  socketPath: string;
  answer(requestId: string, answer: BrokerAnswer): boolean;
  denyAll(message: string): void;
  close(): void;
}

function accept(
  conn: Socket,
  pending: Map<string, Pending>,
  onAsk: (ask: BrokerAsk) => void,
): void {
  const owned = new Set<string>();
  conn.setEncoding("utf8");
  let buffer = "";
  conn.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const ask = parseAsk(line);
      if (!ask || pending.has(ask.requestId)) continue;
      owned.add(ask.requestId);
      const timer = setTimeout(() => {
        if (!pending.delete(ask.requestId)) return;
        owned.delete(ask.requestId);
        try {
          conn.write(
            `${JSON.stringify({ t: "answer", id: ask.requestId, behavior: "deny", message: "15 分钟没有回答" })}\n`,
          );
        } catch {
          // 代理已经走了。
        }
      }, 15 * 60_000);
      pending.set(ask.requestId, {
        kind: ask.kind,
        finish: (answer) => {
          clearTimeout(timer);
          owned.delete(ask.requestId);
          try {
            conn.write(`${JSON.stringify({ t: "answer", id: ask.requestId, ...answer })}\n`);
          } catch {
            // 代理已经走了。
          }
        },
      });
      onAsk(ask);
    }
  });
  conn.on("close", () => {
    for (const id of owned) {
      const ask = pending.get(id);
      if (!ask) continue;
      pending.delete(id);
      ask.finish({ behavior: "deny" });
    }
  });
  conn.on("error", () => {});
}

function parseAsk(line: string): BrokerAsk | null {
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const ask = parsed as Record<string, unknown>;
  if (ask.t !== "ask" || typeof ask.id !== "string") return null;
  const kind = ask.kind === "question" ? "question" : "permission";
  const tool = typeof ask.tool === "string" && ask.tool ? ask.tool : "tool";
  const input =
    ask.input && typeof ask.input === "object" ? (ask.input as Record<string, unknown>) : {};
  const summary =
    typeof input.command === "string"
      ? input.command
      : typeof input.question === "string"
        ? input.question
        : tool;
  return {
    requestId: ask.id,
    kind,
    tool,
    summary: summary.slice(0, 200),
    ...(typeof input.command === "string" ? { command: input.command } : {}),
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
  };
}
