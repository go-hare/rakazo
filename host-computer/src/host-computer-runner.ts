import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { HostComputerFrame, HostComputerRequest } from "./protocol.ts";
import {
  HOST_COMPUTER_MAX_FILE_BYTES,
  hostComputerDeadlineMs,
  hostComputerRequest,
} from "./protocol.ts";
import type { HostScreen } from "./screen.ts";
import { HostScreenError } from "./screen.ts";

/** Where one request's frames go. A write may wait for the transport to drain. */
export interface HostComputerSink {
  /** Called once the request is accepted, before the first frame. */
  open(): void;
  write(frame: HostComputerFrame<unknown>): void | Promise<void>;
}

export type HostComputerOutcome = "invalid" | "disabled" | "busy" | "finished";

export interface HostComputerCall {
  readonly signal: AbortSignal;
  abort(): void;
  /** Validates and runs one request. Nothing is written after the call is aborted. */
  run(input: unknown, sink: HostComputerSink): Promise<HostComputerOutcome>;
  /** Releases the slot. Always call it, even when `run` was never reached. */
  end(): void;
}

/**
 * Runs host computer requests from any transport: the local HTTP listener and the outbound
 * device socket share validation, limits, cancellation, and error sanitizing.
 */
export function createHostComputerRunner(options: { root: string; screen?: HostScreen }) {
  let enabled = false;
  const active = new Map<
    AbortController,
    { botId: string; runId?: string; method: string } | undefined
  >();
  // Reconstruct only our own workspace path. Never trust a caller's providerRef or filesystem root.
  function homeFor(botId: string) {
    const key = createHash("sha256").update(botId).digest("hex");
    return path.join(options.root, "desktop-computers", key);
  }

  function screen() {
    if (!options.screen)
      throw new HostScreenError("Screen control is not available on this computer.");
    return options.screen;
  }

  async function* dispatch(
    input: HostComputerRequest,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    const home = homeFor(input.botId);
    const scope = { botId: input.botId, signal };
    switch (input.method) {
      case "screenObserve":
        yield await screen().observe(scope, input.app, { query: input.query });
        break;
      case "screenAct":
        yield await screen().act(scope, input.app, input.actions);
        break;
      case "environment":
        yield {
          platform: process.platform,
          home: homedir(),
          shell: process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh",
        };
        break;
      case "provision":
        await mkdir(home, { recursive: true });
        await rm(`${home}.stopped`, { force: true });
        yield { botId: input.botId, providerRef: `host:${path.basename(home)}` };
        break;
      case "isRunning":
        yield await running(home);
        break;
      case "prepare":
        yield null;
        break;
      case "execute":
        if (!(await running(home))) throw new Error("Local computer stopped");
        yield* execute(home, input.command, signal);
        break;
      case "workspaceDirectories":
        yield await directories(home, input.directories);
        break;
      case "cancelRunWork":
        for (const [controller, work] of active) {
          if (
            work?.method === "execute" &&
            work.botId === input.botId &&
            work.runId === input.targetRunId
          )
            controller.abort();
        }
        yield null;
        break;
      case "listFiles":
        yield await listFiles(home, input.path);
        break;
      case "readFile":
        yield await readContained(home, input.path, input.maxBytes ?? HOST_COMPUTER_MAX_FILE_BYTES);
        break;
      case "writeFile":
        await writeContained(home, input.file.path, input.file.content, input.file.executable);
        yield null;
        break;
      case "snapshot":
        yield { id: `desktop-snap-${path.basename(home)}`, createdAt: new Date().toISOString() };
        break;
      case "stop":
      case "destroy":
        for (const [controller, work] of active) {
          if (work?.botId === input.botId && controller.signal !== signal) controller.abort();
        }
        if (input.method === "destroy") await rm(home, { recursive: true, force: true });
        else await writeFile(`${home}.stopped`, "");
        yield null;
        break;
    }
  }

  function abortAll() {
    for (const controller of active.keys()) controller.abort();
  }

  return {
    isEnabled: () => enabled,
    setEnabled(value: boolean) {
      enabled = value;
      if (!value) abortAll();
    },
    close() {
      enabled = false;
      abortAll();
    },
    /** Reserves a slot before the request body arrives, or null when execution capacity is full. */
    begin(): HostComputerCall | null {
      // Keep four bounded slots for cancellation and shutdown when commands fill execution capacity.
      if (active.size >= 20) return null;
      const controller = new AbortController();
      active.set(controller, undefined);
      const signal = controller.signal;
      const abort = () => controller.abort();
      return {
        signal,
        abort,
        end: () => active.delete(controller),
        async run(input, sink) {
          const parsed = hostComputerRequest.safeParse(input);
          if (!parsed.success) return "invalid";
          if (!enabled || signal.aborted) return "disabled";
          const lifecycle =
            parsed.data.method === "cancelRunWork" ||
            parsed.data.method === "stop" ||
            parsed.data.method === "destroy";
          if (!lifecycle && active.size > 16) return "busy";
          active.set(controller, {
            botId: parsed.data.botId,
            runId: parsed.data.runId,
            method: parsed.data.method,
          });
          const deadline = setTimeout(abort, hostComputerDeadlineMs(parsed.data));
          deadline.unref();
          sink.open();
          // Quiet commands must keep clients and intermediaries from timing out between frames.
          const heartbeat = setInterval(() => {
            if (!signal.aborted) void Promise.resolve(sink.write({ heartbeat: true })).catch(abort);
          }, 30_000);
          heartbeat.unref();
          try {
            for await (const value of dispatch(parsed.data, signal)) {
              if (signal.aborted) break;
              await sink.write({ value });
            }
            if (!signal.aborted) await sink.write({ done: true });
          } catch (error) {
            if (!signal.aborted)
              await Promise.resolve(sink.write({ error: hostComputerErrorMessage(error) })).catch(
                () => undefined,
              );
          } finally {
            clearTimeout(deadline);
            clearInterval(heartbeat);
          }
          return "finished";
        },
      };
    },
  };
}

async function running(home: string) {
  const [info, stopped] = await Promise.all([
    stat(home).catch(() => undefined),
    stat(`${home}.stopped`).then(
      () => true,
      () => false,
    ),
  ]);
  return Boolean(info?.isDirectory()) && !stopped;
}

async function* execute(
  home: string,
  command: {
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    unsetEnv?: string[];
    timeoutMs?: number;
  },
  signal: AbortSignal,
): AsyncIterable<{ type: string; data?: string; code?: number }> {
  const [program, ...args] = command.argv;
  if (!program) {
    yield { type: "stderr", data: "command rejected\n" };
    yield { type: "exit", code: 1 };
    return;
  }
  const cwd =
    command.cwd && command.cwd !== "/home/rakazo" && command.cwd !== "/home/user"
      ? containedPath(home, command.cwd)
      : home;
  const child = spawn(program, args, {
    cwd,
    env: commandEnvironment(command.env, command.unsetEnv),
    shell: false,
    detached: process.platform !== "win32",
  });
  const queue: Array<{ type: string; data?: string; code?: number }> = [];
  let finished = false;
  let wake: (() => void) | undefined;
  const push = (event: { type: string; data?: string; code?: number }) => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };
  const onAbort = () => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill();
      }
    } else child.kill();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  child.stdout?.on("data", (chunk: Buffer) => push({ type: "stdout", data: chunk.toString() }));
  child.stderr?.on("data", (chunk: Buffer) => push({ type: "stderr", data: chunk.toString() }));
  child.on("error", () => push({ type: "exit", code: 1 }));
  child.on("exit", (exited) => {
    finished = true;
    push({ type: "exit", code: exited ?? (signal.aborted ? 130 : 1) });
  });
  while (!finished || queue.length > 0) {
    if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    const event = queue.shift();
    if (event) yield event;
  }
  signal.removeEventListener("abort", onAbort);
}

function commandEnvironment(set: Record<string, string> | undefined, unset: string[] | undefined) {
  const blocked = new Set(unset ?? []);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !blocked.has(name)) env[name] = value;
  }
  return { ...env, ...set };
}

async function directories(
  home: string,
  request: { action: string; paths?: string[]; parent?: string; names?: string[] },
) {
  if (request.action === "ensure") {
    for (const directory of request.paths ?? []) await mkdir(containedPath(home, directory), { recursive: true });
    return null;
  }
  if (request.action === "list") {
    const names: string[] = [];
    for (const parent of ["bots", ".browser-profiles"]) {
      const entries = await readdir(path.join(home, parent)).catch(() => []);
      names.push(...entries.map((name) => `${parent}/${name}`));
    }
    return names;
  }
  const parent = containedPath(home, request.parent ?? "");
  for (const name of request.names ?? []) {
    if (name.includes("/") || name.includes("..")) throw new Error("Path escapes the computer workspace");
    await rm(path.join(parent, name), { recursive: true, force: true });
  }
  return null;
}

async function listFiles(home: string, relative: string) {
  const target = containedPath(home, relative);
  const entries = await readdir(target, { withFileTypes: true });
  return Promise.all(
    entries.map(async (entry) => {
      const info = await stat(path.join(target, entry.name));
      return {
        path: path.join(relative, entry.name),
        kind: entry.isDirectory() ? "dir" : "file",
        size: info.size,
      };
    }),
  );
}

async function readContained(home: string, relative: string, maxBytes: number) {
  const content = await readFile(containedPath(home, relative));
  if (content.byteLength > maxBytes) throw new Error(`computer file exceeds ${maxBytes} bytes`);
  return content.toString("base64");
}

async function writeContained(
  home: string,
  relative: string,
  content: string,
  executable: boolean | undefined,
) {
  const target = containedPath(home, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(content, "base64"), { mode: executable ? 0o700 : 0o600 });
}

function containedPath(home: string, relative: string) {
  const target = path.resolve(home, relative);
  const relativeToHome = path.relative(home, target);
  if (relativeToHome === ".." || relativeToHome.startsWith(`..${path.sep}`)) {
    throw new Error("Path escapes the computer workspace");
  }
  return target;
}

/** Only messages that reveal nothing beyond the caller's own request leave this computer. */
function hostComputerErrorMessage(error: unknown) {
  if (error instanceof HostScreenError) return error.message;
  if (
    error instanceof Error &&
    (error.message === "Path escapes the computer workspace" ||
      /^computer file exceeds \d+ bytes$/.test(error.message))
  ) {
    return error.message;
  }
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    return "computer file not found";
  return "Local computer operation failed";
}
