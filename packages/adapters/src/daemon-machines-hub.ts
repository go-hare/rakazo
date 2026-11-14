import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  createDaemonMachineStore,
  expireLiveDaemonAsks,
  expireOverdueLiveDaemonAsks,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

const LEASE_MS = 30_000;
const SCAN_MS = 1_000;

export interface MachineTurn {
  botId: string;
  threadId: string;
  turnId: string;
  text: string;
  cwd: string;
  agent: string;
  permission: string;
  model?: string;
  effort?: string;
  system?: string;
  volatile?: string;
  mcp?: Record<string, unknown>;
  images?: Array<{ mime: string; data: string }>;
}

type Store = ReturnType<typeof createDaemonMachineStore>;
type RecordOfMachine = { id: string; userId: string; name: string };
type Turn = {
  threadId: string;
  text: string;
  done: boolean;
  ok: boolean;
  error?: string;
  runId?: string;
  attemptId?: string;
  fence?: number;
  spaceId?: string;
  botId?: string;
};
type LiveMachine = { socket: WebSocket; connectionId: string; turns: Map<string, Turn> };

export interface MachineHub {
  store: Store;
  loginPage(callback: string, name: string): string;
  issue(name: string, userId: string, sessionId?: string): ReturnType<Store["issue"]>;
  list(userId: string): Promise<Array<{ id: string; name: string; online: boolean; cwd: string }>>;
  pin(
    botId: string,
    machineId: string,
    cwd: string,
    agent: string | undefined,
    userId: string,
  ): Promise<boolean>;
  unpin(botId: string, userId: string): Promise<boolean>;
  pinned(botId: string): ReturnType<Store["pinned"]>;
  assignments(
    userId: string,
  ): Promise<Record<string, { machineId: string; cwd: string; agent?: string }>>;
  online(machineId: string): Promise<boolean>;
  send(machineId: string, spaceId: string, turn: MachineTurn): Promise<void>;
  cancel(machineId: string, threadId: string, turnId: string): Promise<boolean>;
  text(turnId: string): Turn | null;
  accept(req: IncomingMessage, socket: Socket, head: Buffer): void;
}

export function createMachines(
  prisma: PrismaClient,
  onFrame: (frame: Record<string, unknown>) => Promise<void>,
  onFailedTurn: (machineId: string, turnId: string) => Promise<void>,
): MachineHub {
  const store = createDaemonMachineStore(prisma);
  const live = new Map<string, LiveMachine>();
  const server = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const report = (error: unknown) => getLogger().error("daemon machine", error);
  const failing = new Map<string, Map<string, Promise<void>>>();
  const failTurns = async (machineId: string, turns: string[]) => {
    await Promise.all(
      turns.map((turnId) => {
        let machineTurns = failing.get(machineId);
        if (!machineTurns) {
          machineTurns = new Map();
          failing.set(machineId, machineTurns);
        }
        const existing = machineTurns.get(turnId);
        if (existing) return existing;
        const pending = (async () => {
          await expireLiveDaemonAsks(prisma, { machineId, turnIds: [turnId] });
          await onFailedTurn(machineId, turnId);
          await store.settleFailedTurn(machineId, turnId);
        })()
          .catch(report)
          .finally(() => {
            machineTurns.delete(turnId);
            if (!machineTurns.size) failing.delete(machineId);
          });
        machineTurns.set(turnId, pending);
        return pending;
      }),
    );
  };
  const releasing = new Set<string>();
  const readingTurns = new Set<string>();
  const recovery = setInterval(() => {
    void store
      .expiredConnections()
      .then((connections) => {
        for (const { id, connectionId } of connections) {
          if (releasing.has(id)) continue;
          releasing.add(id);
          void store
            .releaseConnection(id, connectionId, true)
            .catch(report)
            .finally(() => {
              releasing.delete(id);
            });
        }
      })
      .catch(report);
    void expireOverdueLiveDaemonAsks(prisma).catch(report);
    void store
      .machinesWithFailedTurns()
      .then((machines) => {
        for (const { machineId } of machines) {
          if (readingTurns.has(machineId)) continue;
          readingTurns.add(machineId);
          void store
            .failedTurns(machineId)
            .then((turns) => {
              void failTurns(machineId, turns);
            })
            .catch(report)
            .finally(() => {
              readingTurns.delete(machineId);
            });
        }
      })
      .catch(report);
  }, 5_000);
  recovery.unref();

  const connected = (client: WebSocket, record: RecordOfMachine) => {
    const connectionId = randomUUID();
    let active = false;
    let closed = false;
    let busy = false;
    let lastRenew = 0;
    let sequence = Promise.resolve();
    const turns = new Map<string, Turn>();
    const awaitingAck = new Map<string, number>();
    const helloTimeout = setTimeout(() => client.terminate(), 10_000);
    helloTimeout.unref();
    const release = async () => {
      if (!active) return;
      active = false;
      if (live.get(record.id)?.connectionId === connectionId) live.delete(record.id);
      await failTurns(record.id, await store.releaseConnection(record.id, connectionId));
    };
    const pump = async () => {
      if (!active || closed || busy) return;
      busy = true;
      try {
        if ([...awaitingAck.values()].some((sentAt) => Date.now() - sentAt > 15_000)) {
          client.terminate();
          return;
        }
        if (Date.now() - lastRenew >= LEASE_MS / 3) {
          if (!(await store.renewConnection(record.id, connectionId, LEASE_MS))) {
            client.terminate();
            return;
          }
          lastRenew = Date.now();
          client.send(JSON.stringify({ type: "lease_heartbeat" }));
        }
        while (active && !closed && client.readyState === 1) {
          const command = await store.claimNext(record.id, connectionId);
          if (!command) break;
          const payload = command.payload;
          if (!payload || typeof payload !== "object" || Array.isArray(payload))
            throw new Error("Invalid daemon command payload");
          if (command.type === "turn") {
            const run = await prisma.run.findFirst({
              where: {
                deviceId: record.id,
                deviceTurnId: command.turnId,
                threadId: command.threadId,
                status: "running",
              },
              select: {
                id: true,
                spaceId: true,
                botId: true,
                leaseFence: true,
                attempts: {
                  where: { status: "running" },
                  select: { id: true, fence: true },
                  take: 1,
                },
              },
            });
            const attempt =
              run?.attempts.find((item) => item.fence === run.leaseFence) ?? run?.attempts[0];
            if (!run || !attempt) {
              await store.reject(record.id, connectionId, command.id);
              continue;
            }
            turns.set(command.turnId, {
              threadId: command.threadId,
              text: "",
              done: false,
              ok: true,
              runId: run.id,
              attemptId: attempt.id,
              fence: attempt.fence,
              spaceId: run.spaceId,
              botId: run.botId,
            });
          }
          awaitingAck.set(command.id, Date.now());
          client.send(JSON.stringify({ ...payload, type: command.type, commandId: command.id }));
        }
      } catch (error) {
        report(error);
        client.terminate();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void pump(), SCAN_MS);
    timer.unref();
    client.on("message", (raw) => {
      sequence = sequence
        .then(async () => {
          if (closed) return;
          const frame = parse(String(raw));
          if (!frame) return;
          if (!active) {
            if (
              frame.type !== "hello" ||
              typeof frame.protocolVersion !== "number" ||
              frame.protocolVersion < 2 ||
              typeof frame.name !== "string" ||
              !frame.name
            ) {
              client.terminate();
              return;
            }
            const oldTurns = await store.acquireConnection(record.id, connectionId, LEASE_MS);
            if (oldTurns === null || closed) {
              client.terminate();
              if (oldTurns !== null) await store.releaseConnection(record.id, connectionId);
              return;
            }
            clearTimeout(helloTimeout);
            active = true;
            lastRenew = Date.now();
            client.send(JSON.stringify({ type: "lease_heartbeat" }));
            live.set(record.id, { socket: client, connectionId, turns });
            await failTurns(record.id, oldTurns);
            await pump();
            return;
          }
          if (!(await store.renewConnection(record.id, connectionId, LEASE_MS))) {
            client.terminate();
            return;
          }
          lastRenew = Date.now();
          client.send(JSON.stringify({ type: "lease_heartbeat" }));
          if (frame.type === "command_ack" || frame.type === "command_rejected") {
            if (typeof frame.commandId !== "string" || !awaitingAck.has(frame.commandId)) return;
            awaitingAck.delete(frame.commandId);
            const status = frame.type === "command_ack" ? "acknowledged" : "rejected";
            if (status === "acknowledged")
              await store.ack(record.id, connectionId, frame.commandId);
            else await store.reject(record.id, connectionId, frame.commandId);
            return;
          }
          const turnId = typeof frame.turnId === "string" ? frame.turnId : "";
          const turn = turns.get(turnId);
          if (!turn || turn.done || frame.threadId !== turn.threadId) return;
          if (frame.type === "delta" && typeof frame.text === "string") turn.text += frame.text;
          if (frame.type === "done") {
            turn.done = true;
            turn.ok = frame.ok !== false;
            if (typeof frame.error === "string") turn.error = frame.error;
          }
          await onFrame({
            ...frame,
            machineId: record.id,
            connectionId,
            runId: turn.runId,
            attemptId: turn.attemptId,
            leaseFence: turn.fence,
            spaceId: turn.spaceId,
            botId: turn.botId,
          });
          if (frame.type === "done") {
            await store.finishTurn(record.id, connectionId, turnId);
            turns.delete(turnId);
          }
        })
        .catch((error) => {
          report(error);
          client.terminate();
        });
    });
    client.on("close", () => {
      closed = true;
      clearTimeout(helloTimeout);
      clearInterval(timer);
      void sequence.then(release).catch(report);
    });
    client.on("error", report);
  };

  return {
    store,
    loginPage(callback, name) {
      const safeName = name.replace(/[<>"&]/g, "");
      return `<!doctype html><meta charset="utf-8"><title>连接这台电脑</title>
<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto">
<h1>把「${safeName}」连到这个账号</h1><button id="connect">连接</button>
<script>document.getElementById("connect").onclick = async () => {
const response = await fetch("/daemon/login", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({callback:${scriptString(callback)},name:${scriptString(name)}})});
const result = await response.json(); if (result.callback) location.href = result.callback; else document.body.append(result.error || "连接失败");};</script>`;
    },
    issue: (name, userId, sessionId) => store.issue(userId, name, sessionId),
    async list(userId) {
      const [machines, pins] = await Promise.all([store.list(userId), store.assignments(userId)]);
      return machines.map((machine) => ({
        id: machine.id,
        name: machine.name,
        online: !!machine.leaseExpiresAt && machine.leaseExpiresAt.getTime() > Date.now(),
        cwd: pins.find((pin) => pin.machineId === machine.id)?.cwd ?? "",
      }));
    },
    pin: (botId, machineId, cwd, agent, userId) => store.pin(userId, botId, machineId, cwd, agent),
    unpin: (botId, userId) => store.unpin(userId, botId),
    pinned: (botId) => store.pinned(botId),
    async assignments(userId) {
      return Object.fromEntries(
        (await store.assignments(userId)).map(({ botId, machineId, cwd, agent }) => [
          botId,
          { machineId, cwd, ...(agent ? { agent } : {}) },
        ]),
      );
    },
    async online(machineId) {
      const machine = await prisma.daemonMachine.findUnique({
        where: { id: machineId },
        select: { leaseExpiresAt: true },
      });
      return !!machine?.leaseExpiresAt && machine.leaseExpiresAt.getTime() > Date.now();
    },
    async send(machineId, spaceId, turn) {
      await store.enqueue({
        machineId,
        spaceId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        type: "turn",
        payload: turn as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + 30_000),
      });
    },
    async cancel(machineId, threadId, turnId) {
      const run = await prisma.run.findFirst({
        where: { deviceId: machineId, deviceTurnId: turnId, threadId },
        select: { spaceId: true },
      });
      if (!run) return false;
      await store.enqueue({
        machineId,
        spaceId: run.spaceId,
        threadId,
        turnId,
        type: "cancel",
        payload: { threadId, turnId },
        expiresAt: new Date(Date.now() + 30_000),
      });
      return true;
    },
    text(turnId) {
      for (const current of live.values()) {
        const turn = current.turns.get(turnId);
        if (turn) return turn;
      }
      return null;
    },
    accept(req, clientSocket, head) {
      void (async () => {
        const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization ?? "")?.[1];
        const record = token ? await store.authenticate(token) : null;
        if (!record || typeof req.headers["sec-websocket-key"] !== "string") {
          clientSocket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          clientSocket.end();
          return;
        }
        server.handleUpgrade(req, clientSocket, head, (client) => connected(client, record));
      })().catch((error) => {
        report(error);
        clientSocket.destroy();
      });
    },
  };
}

function scriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
function parse(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
