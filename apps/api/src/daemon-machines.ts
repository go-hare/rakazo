import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { createMachines, RunJobPublisher } from "@rakazo/adapters";
import type { FinalizeRunInput, PrismaClient, ThreadEvents } from "@rakazo/db";
import { createLiveDaemonAsk, finalizeRun } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";

const LEASE_OWNER = "daemon";

const streamed = new Set<string>();

export function startDaemonMachines(
  dataDir: string,
  prisma: PrismaClient,
  events: Pick<ThreadEvents, "append" | "notify">,
) {
  void dataDir;
  const machines = createMachines(
    prisma,
    async (frame) => {
      // Same four frames as the other app: content.delta, request.opened, item.completed, turn.completed.
      const threadId = typeof frame.threadId === "string" ? frame.threadId : "";
      const turnId = typeof frame.turnId === "string" ? frame.turnId : "";
      const machineId = typeof frame.machineId === "string" ? frame.machineId : "";
      if (frame.type === "delta" && threadId && typeof frame.text === "string") {
        if (frame.kind === "reasoning") return;
        await publishDaemonDelta(prisma, events, machineId, turnId, frame.text);
      }
      if (frame.type === "ask" && threadId && typeof frame.summary === "string") {
        await openDaemonAsk(prisma, events, frame);
      }
      if (frame.type === "image" && threadId && typeof frame.data === "string") {
        await publishDaemonNote(prisma, events, machineId, turnId, "[image]");
      }
      if (frame.type === "tool" && threadId && typeof frame.title === "string") {
        await publishDaemonNote(prisma, events, machineId, turnId, frame.title);
      }
      if (frame.type === "done" && threadId && turnId) {
        streamed.delete(turnId);
        const text = machines.text(turnId)?.text ?? "";
        await completeDaemonTurn(prisma, machineId, turnId, {
          ok: frame.ok !== false,
          error: typeof frame.error === "string" ? frame.error : undefined,
          text,
        });
      }
    },
    async (machineId, turnId) => {
      await completeDaemonTurn(prisma, machineId, turnId, {
        ok: false,
        error: "Connection lost before the turn completed.",
        text: "",
      });
    },
  );
  return machines;
}

let boundMachines: ReturnType<typeof startDaemonMachines> | null = null;

export type DaemonRunStop = { deviceId: string; deviceTurnId: string; threadId: string };

export function bindDaemonMachines(machines: ReturnType<typeof startDaemonMachines>) {
  boundMachines = machines;
}

export function cancelDaemonTurn(run: DaemonRunStop) {
  void boundMachines
    ?.cancel(run.deviceId, run.threadId, run.deviceTurnId)
    .catch((error) => getLogger().error("cancel daemon turn", error));
}

export function mountDaemonMachines(
  app: Hono,
  machines: ReturnType<typeof startDaemonMachines>,
  session: (request: Request) => Promise<{ userId: string; sessionId?: string } | null>,
  prisma: PrismaClient,
) {
  app.get("/daemon/login", (c) => {
    const callback = c.req.query("callback") ?? "";
    const name = c.req.query("name") ?? "电脑";
    if (!validCallback(callback)) return c.text("callback 必须是本机", 400);
    return c.html(machines.loginPage(callback, name));
  });
  app.post("/daemon/login", async (c) => {
    const user = await session(c.req.raw);
    if (!user) return c.json({ error: "sign in first" }, 401);
    const body = (await c.req.json().catch(() => null)) as {
      callback?: unknown;
      name?: unknown;
      desktop?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name : "电脑";
    if (body?.desktop === true) {
      if (!user.sessionId) return c.json({ error: "sign in first" }, 401);
      try {
        const machine = await machines.issue(name, user.userId, user.sessionId);
        return c.json({ token: machine.token, userId: machine.userId, sessionId: user.sessionId });
      } catch {
        return c.json({ error: "sign in first" }, 401);
      }
    }
    const callback = typeof body?.callback === "string" ? body.callback : "";
    if (!validCallback(callback)) return c.json({ error: "callback 必须是本机" }, 400);
    const machine = await machines.issue(name, user.userId);
    const destination = new URL(callback);
    destination.searchParams.set("token", machine.token);
    return c.json({ callback: destination.toString() });
  });
  app.delete("/api/machines/self", async (c) => {
    const token = /^Bearer ([a-f0-9]{64})$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) return c.json({ error: "sign in first" }, 401);
    if (!(await machines.store.revokeToken(token))) {
      return c.json({ error: "Machine not found" }, 404);
    }
    return c.json({ ok: true });
  });
  app.get("/api/machines", async (c) => {
    const user = await session(c.req.raw);
    if (!user) return c.json({ error: "sign in first" }, 401);
    return c.json({
      machines: await machines.list(user.userId),
      pins: await machines.assignments(user.userId),
    });
  });
  app.delete("/api/machines/:machineId", async (c) => {
    const user = await session(c.req.raw);
    if (!user) return c.json({ error: "sign in first" }, 401);
    if (!(await machines.store.revoke(user.userId, c.req.param("machineId")))) {
      return c.json({ error: "Machine not found" }, 404);
    }
    return c.json({ ok: true });
  });
  app.post("/api/bots/:botId/machine", async (c) => {
    const user = await session(c.req.raw);
    if (!user) return c.json({ error: "sign in first" }, 401);
    const bot = await prisma.bot.findFirst({
      where: {
        id: c.req.param("botId"),
        space: { memberships: { some: { userId: user.userId } } },
      },
      select: { id: true },
    });
    if (!bot) return c.json({ error: "没有这个 bot" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      machineId?: unknown;
      cwd?: unknown;
      agent?: unknown;
    } | null;
    if (body?.machineId === "") {
      await machines.unpin(bot.id, user.userId);
      return c.json({ ok: true });
    }
    const machineId = typeof body?.machineId === "string" ? body.machineId : "";
    const cwd = typeof body?.cwd === "string" ? body.cwd : "";
    const agent = typeof body?.agent === "string" ? body.agent : undefined;
    if (!(await machines.pin(c.req.param("botId"), machineId, cwd, agent, user.userId))) {
      return c.json({ error: "没有这台机器，或者没给目录" }, 400);
    }
    return c.json({ ok: true });
  });
}

export function acceptDaemonUpgrade(
  machines: ReturnType<typeof startDaemonMachines>,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) {
  const path = new URL(request.url ?? "/", "http://daemon").pathname;
  if (path !== "/api/machines/connect") return false;
  machines.accept(request, socket as Socket, head);
  return true;
}

export function attachDaemonRuns(
  jobs: JobPublisher,
  prisma: PrismaClient,
  _machines: ReturnType<typeof startDaemonMachines>,
  events: Pick<ThreadEvents, "finalizeRun">,
) {
  if (!(jobs instanceof RunJobPublisher)) return;
  jobs.ownRun = async (runId) => {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: {
        id: true,
        status: true,
        spaceId: true,
        threadId: true,
        botId: true,
        taskId: true,
        leaseFence: true,
        leaseOwner: true,
        deviceId: true,
        deviceTurnId: true,
        attempts: { where: { status: "running" }, select: { id: true, fence: true } },
      },
    });
    if (!run) return false;
    let claim: { attemptId: string; fence: number } | null = null;
    if (run.status === "running" && run.leaseOwner === "daemon-unavailable") {
      const attempt = run.attempts.find((item) => item.fence === run.leaseFence);
      if (attempt) claim = { attemptId: attempt.id, fence: attempt.fence };
    } else {
      if (run.status !== "queued") {
        return run.leaseOwner === LEASE_OWNER || !!run.deviceId || !!run.deviceTurnId;
      }
      return false;
    }
    if (claim) {
      const result = await events.finalizeRun({
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        taskId: run.taskId,
        attemptId: claim.attemptId,
        leaseOwner: "daemon-unavailable",
        leaseFence: claim.fence,
        outcome: "failed",
        error: "Execution on this computer is temporarily unavailable.",
      });
      if (result !== false && result.continuationRunId) {
        await jobs.enqueue({ name: "run.continue", payload: { runId: result.continuationRunId } });
      }
    }
    return true;
  };
}

export function createDaemonRunGateway(
  machines: ReturnType<typeof startDaemonMachines>,
  prisma: PrismaClient,
) {
  return {
    async run(input: {
      runId: string;
      attemptId: string;
      leaseOwner: string;
      leaseFence: number;
      botId: string;
      spaceId: string;
      threadId: string;
      userId: string;
      signal: AbortSignal;
    }) {
      const pin = await machines.pinned(input.botId);
      if (!pin) return "unassigned" as const;
      const agent =
        pin.agent === "codex" || pin.agent === "grok" || pin.agent === "claude"
          ? pin.agent
          : "claude";
      const text = await loadTurnText(prisma, input.runId);
      const turnId = randomUUID();
      const submitted = await machines.store.submitTurn({
        runId: input.runId,
        attemptId: input.attemptId,
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
        botId: input.botId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        userId: input.userId,
        machineId: pin.machineId,
        turnId,
        payload: {
          type: "turn",
          botId: input.botId,
          threadId: input.threadId,
          turnId,
          text,
          cwd: pin.cwd,
          agent,
          permission: "default",
        },
      });
      if (!submitted) throw new Error("Daemon turn was not submitted");
      await waitWhile(
        async () =>
          (
            await prisma.run.findUnique({
              where: { id: input.runId },
              select: { status: true },
            })
          )?.status === "running",
        input.signal,
      );
      if (!input.signal.aborted) {
        await waitWhile(async () => {
          const bot = await prisma.bot.findUnique({
            where: { id: input.botId },
            select: { daemonUncertainUntil: true },
          });
          return !!bot?.daemonUncertainUntil && bot.daemonUncertainUntil.getTime() > Date.now();
        }, input.signal);
      }
      return "handled" as const;
    },
  };
}

async function completeDaemonTurn(
  prisma: PrismaClient,
  machineId: string,
  turnId: string,
  frame: { ok: boolean; error?: string; text: string },
) {
  const run = await prisma.run.findFirst({
    where: {
      deviceId: machineId,
      deviceTurnId: turnId,
      status: "running",
    },
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      botId: true,
      taskId: true,
      leaseOwner: true,
      leaseFence: true,
      attempts: { where: { status: "running" }, select: { id: true, fence: true } },
    },
  });
  const attempt = run?.attempts.find((item) => item.fence === run.leaseFence) ?? run?.attempts[0];
  if (!run || !attempt || !run.leaseOwner) return;
  await finalizeRun(
    prisma,
    frame.ok
      ? {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          runId: run.id,
          taskId: run.taskId,
          attemptId: attempt.id,
          leaseOwner: run.leaseOwner,
          leaseFence: run.leaseFence,
          outcome: "completed",
          blocks: frame.text ? [{ kind: "text", text: frame.text }] : [],
        }
      : failed(
          run,
          attempt.id,
          run.leaseOwner,
          run.leaseFence,
          frame.error ?? "The agent failed.",
          frame.text,
        ),
  );
}

function failed(
  run: { id: string; spaceId: string; threadId: string; botId: string; taskId: string },
  attemptId: string,
  leaseOwner: string,
  fence: number,
  error: string,
  text = "",
): FinalizeRunInput {
  return {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId: run.id,
    taskId: run.taskId,
    attemptId,
    leaseOwner,
    leaseFence: fence,
    outcome: "failed",
    error,
    ...(text ? { partialReply: [{ kind: "text" as const, text }] } : {}),
  };
}

async function publishDaemonDelta(
  prisma: PrismaClient,
  events: Pick<ThreadEvents, "append">,
  machineId: string,
  turnId: string,
  text: string,
) {
  const run = await prisma.run.findFirst({
    where: {
      deviceId: machineId,
      deviceTurnId: turnId,
      status: "running",
    },
    select: { id: true, spaceId: true, threadId: true, botId: true },
  });
  if (!run) return;
  const first = !streamed.has(turnId);
  streamed.add(turnId);
  await events.append({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.progress",
    runId: run.id,
    payload: first ? { text, streaming: true } : { delta: text, streaming: true },
  });
}

async function publishDaemonNote(
  prisma: PrismaClient,
  events: Pick<ThreadEvents, "append">,
  machineId: string,
  turnId: string,
  summary: string,
) {
  const run = await prisma.run.findFirst({
    where: {
      deviceId: machineId,
      deviceTurnId: turnId,
      status: "running",
    },
    select: { id: true, spaceId: true, threadId: true, botId: true },
  });
  if (!run) return;
  await events.append({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.progress",
    runId: run.id,
    payload: { text: summary, streaming: true },
  });
}

async function openDaemonAsk(
  prisma: PrismaClient,
  events: Pick<ThreadEvents, "append" | "notify">,
  frame: Record<string, unknown>,
) {
  const machineId = typeof frame.machineId === "string" ? frame.machineId : "";
  const connectionId = typeof frame.connectionId === "string" ? frame.connectionId : "";
  const threadId = typeof frame.threadId === "string" ? frame.threadId : "";
  const turnId = typeof frame.turnId === "string" ? frame.turnId : "";
  const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
  const runId = typeof frame.runId === "string" ? frame.runId : "";
  const attemptId = typeof frame.attemptId === "string" ? frame.attemptId : "";
  const spaceId = typeof frame.spaceId === "string" ? frame.spaceId : "";
  const leaseFence = typeof frame.leaseFence === "number" ? frame.leaseFence : Number.NaN;
  const kind =
    frame.kind === "question" ? "question" : frame.kind === "permission" ? "permission" : null;
  const summary = typeof frame.summary === "string" ? frame.summary : "";
  if (
    !machineId ||
    !connectionId ||
    !threadId ||
    !turnId ||
    !requestId ||
    !runId ||
    !attemptId ||
    !spaceId ||
    !kind ||
    !summary ||
    !Number.isInteger(leaseFence)
  )
    return;
  const command = typeof frame.command === "string" ? frame.command : undefined;
  const created = await createLiveDaemonAsk(prisma, {
    spaceId,
    threadId,
    runId,
    attemptId,
    leaseFence,
    machineId,
    connectionId,
    turnId,
    requestId,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    kind,
    block:
      kind === "permission"
        ? {
            kind: "ask",
            text: summary,
            ...(command ? { detail: command, detailFormat: "code" as const } : {}),
            status: "pending",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          }
        : { kind: "ask", text: summary, status: "pending", input: "text" },
  });
  if (created) {
    await events.notify(threadId, created.seq).catch((error) => {
      getLogger().error("daemon ask realtime notification", error);
    });
  }
}

async function loadTurnText(prisma: PrismaClient, runId: string) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
    },
  });
  const prompt = run?.task?.prompt.trim();
  if (prompt) return prompt;
  const blocks = run?.sourceMessage?.blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap((block) =>
      block &&
      typeof block === "object" &&
      "kind" in block &&
      block.kind === "text" &&
      "text" in block
        ? [String(block.text)]
        : [],
    )
    .join("\n");
}

async function waitWhile(predicate: () => Promise<boolean>, signal: AbortSignal) {
  while (!signal.aborted && (await predicate())) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function validCallback(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !!url.port &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}
