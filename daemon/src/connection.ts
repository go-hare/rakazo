import { setTimeout as delay } from "node:timers/promises";
import type { AgentEmit } from "./agent.ts";
import {
  answerTurn,
  cancelAllTurns,
  cancelTurn,
  completeTeam,
  runTurn,
  steerTurn,
} from "./agent.ts";
import type { DaemonConfig } from "./config.ts";
import { leaseWatchdog } from "./lease-watchdog.ts";
import type { DaemonFrame } from "./protocol.ts";
import { launchOptions, parseCloudFrame } from "./protocol.ts";

const RETRY_MS = 2_000;
const LEASE_HEARTBEAT_TIMEOUT_MS = 20_000;

/** 本机主动连出去；连接中断时停止正在运行的 turn。 */
export function connect(config: DaemonConfig, signal: AbortSignal): Promise<void> {
  return loop(config, signal);
}

async function loop(config: DaemonConfig, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await once(config, signal);
    } catch (error) {
      if (signal.aborted) return;
      console.error("连接断开：", error instanceof Error ? error.message : error);
    }
    if (!signal.aborted) await delay(RETRY_MS, undefined, { signal }).catch(() => {});
  }
}

async function once(config: DaemonConfig, signal: AbortSignal): Promise<void> {
  const socket = new WebSocket(socketUrl(config), {
    // Bun 的 WebSocket 客户端接受 headers；DOM 的 lib 没有这一项。
    headers: { authorization: `Bearer ${config.token}` },
  } as unknown as string[]);
  const connection = new AbortController();
  let watchdog: ReturnType<typeof leaseWatchdog> | undefined;
  let stopWaiting!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stopWaiting = resolve;
  });
  const stop = () => {
    connection.abort();
    stopWaiting();
    socket.close();
  };
  const closed = new Promise<void>((resolve) => {
    const disconnected = () => {
      connection.abort();
      resolve();
    };
    socket.addEventListener("close", disconnected, { once: true });
    socket.addEventListener("error", disconnected, { once: true });
  });
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const opened = await Promise.race([
      new Promise<boolean>((resolve) => {
        socket.addEventListener("open", () => resolve(true), { once: true });
      }),
      closed.then(() => false),
      stopped.then(() => false),
    ]);
    if (!opened || signal.aborted) return;
    watchdog = leaseWatchdog(LEASE_HEARTBEAT_TIMEOUT_MS, stop);
    send(socket, { type: "hello", name: config.name, protocolVersion: 2 });
    console.log("已连上", config.server);
    const emit: AgentEmit = (frame) => send(socket, frame);
    socket.addEventListener("message", (event) => {
      if (connection.signal.aborted) return;
      const raw = String(event.data);
      try {
        const message: unknown = JSON.parse(raw);
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "lease_heartbeat"
        ) {
          watchdog?.receiveHeartbeat();
          return;
        }
      } catch {
        return;
      }
      if (!watchdog?.canReceive()) return;
      const frame = parseCloudFrame(raw);
      if (!frame) return;
      if (frame.type === "cancel") {
        const accepted = cancelTurn(frame.threadId, frame.turnId);
        if (frame.commandId)
          send(socket, {
            type: accepted ? "command_ack" : "command_rejected",
            commandId: frame.commandId,
          });
        return;
      }
      if (frame.type === "answer") {
        const accepted = answerTurn(
          frame.threadId,
          frame.turnId,
          frame.requestId,
          frame.behavior,
          frame.message,
        );
        if (frame.commandId)
          send(socket, {
            type: accepted ? "command_ack" : "command_rejected",
            commandId: frame.commandId,
          });
        return;
      }
      if (frame.type === "steer") {
        steerTurn(frame.threadId, frame.text);
        return;
      }
      if (frame.type === "team_result") {
        completeTeam(frame.threadId, frame.requestId, frame.ok, frame.text);
        return;
      }
      if (frame.commandId) send(socket, { type: "command_ack", commandId: frame.commandId });
      void runTurn(
        {
          threadId: frame.threadId,
          turnId: frame.turnId,
          text: frame.text,
          cwd: frame.cwd,
          agent: frame.agent,
          options: launchOptions(frame),
          images: frame.images ?? [],
        },
        emit,
        connection.signal,
      );
    });
    await Promise.race([closed, stopped]);
  } finally {
    watchdog?.close();
    signal.removeEventListener("abort", stop);
    connection.abort();
    cancelAllTurns();
  }
}

function send(socket: WebSocket, frame: DaemonFrame): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function socketUrl(config: DaemonConfig): string {
  const url = new URL("/api/machines/connect", config.server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
