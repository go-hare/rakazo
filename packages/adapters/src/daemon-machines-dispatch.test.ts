import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext, runAsSystem } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMachines } from "./daemon-machines-hub.js";

const upgrade = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("ws", () => ({
  WebSocketServer: class {
    handleUpgrade(
      _request: unknown,
      _socket: unknown,
      _head: unknown,
      connected: (client: unknown) => void,
    ) {
      connected(upgrade.client);
    }
  },
}));

class DaemonSocket extends EventEmitter {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  send(raw: string) {
    this.frames.push(JSON.parse(raw));
  }
  terminate() {
    this.readyState = 3;
    this.emit("close");
  }
  receive(frame: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
}

async function fixture(pending = true, runExists = true) {
  let status = pending ? "pending" : "waiting";
  let connectionId: string | null = null;
  const command = {
    id: "command",
    machineId: "machine",
    spaceId: "space",
    threadId: "thread",
    turnId: "turn",
    type: "turn",
    payload: { threadId: "thread", turnId: "turn", text: "test" },
  };
  const visibleRun = () => runExists && currentDbContext()?.kind === "system";
  const transaction = {
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes('SELECT m."connectionId"')) return [{ connectionId }];
      if (sql.includes("SELECT m.id FROM daemon_machines")) return [{ id: "machine" }];
      if (sql.includes("UPDATE daemon_commands SET status = 'sending'")) {
        if (status !== "pending") return [];
        status = "sending";
        connectionId = values[0] as string;
        return [command];
      }
      if (sql.includes('SELECT r."botId" FROM runs')) return visibleRun() ? [{ botId: "bot" }] : [];
      if (sql.includes("RETURNING id") || sql.includes("RETURNING m.id"))
        return [{ id: "machine" }];
      throw new Error(`Unexpected query: ${sql}`);
    },
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes('UPDATE daemon_machines SET "connectionId" = ?,'))
        connectionId = values[0] as string;
      if (sql.includes("SET status = 'finished'")) status = "finished";
      return 1;
    },
    daemonCommand: {
      updateMany: async ({ data }: { data: { status: string } }) => {
        status = data.status;
        return { count: 1 };
      },
      findMany: async () => (status === "sending" ? [{ turnId: "turn" }] : []),
    },
  };
  const prisma = {
    ...transaction,
    $contentEncryption: () => ({ openRows: async (_model: string, rows: unknown[]) => rows }),
    $transaction: async (fn: (tx: typeof transaction) => unknown) => fn(transaction),
    $queryRaw: async () => [{ id: "machine", userId: "user", name: "Test" }],
    run: {
      findFirst: async () =>
        visibleRun()
          ? {
              id: "run",
              spaceId: "space",
              botId: "bot",
              leaseFence: 1,
              attempts: [{ id: "attempt", fence: 1 }],
            }
          : null,
    },
  } as unknown as PrismaClient;
  const frames: Array<Record<string, unknown>> = [];
  const failed: string[] = [];
  const hub = await runAsSystem("api startup", () =>
    createMachines(
      prisma,
      async (frame) => {
        if (currentDbContext()?.kind === "system") frames.push(frame);
      },
      async (_machineId, turnId) => {
        if (currentDbContext()?.kind === "system") failed.push(turnId);
      },
    ),
  );
  const client = new DaemonSocket();
  upgrade.client = client;
  hub.accept(
    {
      headers: { authorization: `Bearer ${"a".repeat(64)}`, "sec-websocket-key": "key" },
    } as IncomingMessage,
    {} as Socket,
    Buffer.alloc(0),
  );
  await vi.advanceTimersByTimeAsync(0);
  client.receive({ type: "hello", protocolVersion: 2, name: "Test" });
  await vi.advanceTimersByTimeAsync(0);
  return { client, frames, failed, status: () => status, enqueue: () => (status = "pending") };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("daemon dispatch outside startup database context", () => {
  it("dispatches a running turn and processes its frames on the same live connection", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    expect(f.client.frames).toContainEqual({
      type: "turn",
      commandId: "command",
      threadId: "thread",
      turnId: "turn",
      text: "test",
    });
    expect(f.status()).toBe("sending");
    f.client.receive({ type: "delta", threadId: "thread", turnId: "turn", text: "hello" });
    f.client.receive({ type: "done", threadId: "thread", turnId: "turn", ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.frames.map((frame) => frame.type)).toEqual(["delta", "done"]);
    expect(f.frames[1]).toMatchObject({ runId: "run", attemptId: "attempt", leaseFence: 1 });
    expect(f.status()).toBe("finished");
    expect(f.client.readyState).toBe(1);
    expect(f.failed).toEqual([]);
  });

  it("dispatches commands arriving after hello from the connection timer", async () => {
    vi.useFakeTimers();
    const f = await fixture(false);
    f.enqueue();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.client.frames).toContainEqual(expect.objectContaining({ type: "turn" }));
    expect(f.status()).toBe("sending");
  });

  it("still rejects a command whose running turn no longer exists", async () => {
    vi.useFakeTimers();
    const f = await fixture(true, false);
    expect(f.status()).toBe("rejected");
    expect(f.client.frames.some((frame) => frame.type === "turn")).toBe(false);
    expect(f.client.readyState).toBe(1);
  });
});
