import { randomUUID } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { BOT_COMPUTER_REQUIRED_SEND_ERROR } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("send model gate with a bot's own model (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let botId: string;
  let call: (path: string, input: Record<string, unknown>) => Promise<Response>;
  const enqueue = vi.fn().mockResolvedValue(undefined);

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `model-gate-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    botId = identity.botId;
    actor = { spaceId: identity.spaceId, userId: identity.userId } as Actor;
    // A working connection, but no main model and no deployment model.
    await system.userModelCredential.create({
      data: { userId: actor.userId, provider: "openrouter", label: "Key", secretId: "fixture" },
    });
    const deps = {
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue, cancel: vi.fn(), close: async () => undefined },
      secrets: { load: vi.fn() },
      sandbox: {},
      env: { agentRuntime: "pi", deploymentModelConfigured: false },
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    call = async (path, input) => {
      const { response } = await handler.handle(
        new Request(`http://127.0.0.1/rpc/threads/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: input }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return response!;
    };
  });
  afterEach(async () => {
    if (!actor) return;
    await system.messagingIdentity.deleteMany({ where: { userId: actor.userId } });
    await system.chatGroup.deleteMany({ where: { userId: actor.userId } });
    await system.organization.deleteMany({ where: { id: actor.spaceId } });
    await system.user.deleteMany({ where: { id: actor.userId } });
  });
  afterAll(async () => {
    await close?.();
  });

  const send = (input: Record<string, unknown>) => call("send", input);
  const useModel = (id: string, modelProvider: string | null) =>
    system.bot.update({
      where: { id },
      data: { modelProvider, modelId: modelProvider ? "openai/gpt-4o" : null },
    });
  const expectRefused = async (response: Response) => {
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      json: { message: BOT_COMPUTER_REQUIRED_SEND_ERROR },
    });
  };
  const userMessages = (threadId: string) =>
    system.message.count({ where: { threadId, role: "user" } });
  /** Reacts 👍 to a fresh reply from `author` and returns the runs the reaction started. */
  const react = async (target: Record<string, string>, threadId: string, author: string) => {
    await system.run.updateMany({ where: { threadId }, data: { status: "completed" } });
    const reply = await createThreadMessage(system, {
      threadId,
      role: "bot",
      botId: author,
      blocks: [{ kind: "text", text: "Done." }],
    });
    const response = await call("react", {
      ...target,
      messageId: reply.id,
      reaction: "👍",
      clientNonce: randomUUID(),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { json: { runIds: string[] } }).json.runIds;
  };

  it("refuses an unbound bot even when it has its own model", async () => {
    const withoutModel = await send({ botId, text: "follows main" });
    expect(withoutModel.status).toBe(400);
    expect(await withoutModel.json()).toMatchObject({
      json: { message: BOT_COMPUTER_REQUIRED_SEND_ERROR },
    });
    await useModel(botId, "openrouter");
    const withModel = await send({ botId, text: "own model" });
    expect(withModel.status).toBe(400);
    expect(await withModel.json()).toMatchObject({
      json: { message: BOT_COMPUTER_REQUIRED_SEND_ERROR },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("starts a bound local bot for a new account without any model credentials", async () => {
    await system.userModelCredential.deleteMany({ where: { userId: actor.userId } });
    const machine = await system.daemonMachine.create({
      data: {
        id: randomUUID(),
        userId: actor.userId,
        name: "Test computer",
        tokenHash: randomUUID(),
        connectionId: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        assignments: { create: { botId, cwd: "/test" } },
      },
    });
    const accepted = await send({ botId, text: "local work", clientNonce: randomUUID() });
    expect(accepted.status).toBe(200);
    const run = await system.run.findFirstOrThrow({ where: { botId, userId: actor.userId } });
    expect(run).toMatchObject({
      botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: "queued",
    });
    expect(enqueue).toHaveBeenCalled();
    await system.daemonMachine.update({
      where: { id: machine.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const offline = await send({ botId, text: "offline" });
    expect(offline.status).toBe(400);
    await expect(offline.json()).resolves.toMatchObject({
      json: { message: "Reconnect this bot's computer and try again." },
    });
    await system.daemonAssignment.delete({ where: { botId } });
    const unbound = await send({ botId, text: "server work" });
    expect(unbound.status).toBe(400);
    expect(await unbound.json()).toMatchObject({
      json: { message: BOT_COMPUTER_REQUIRED_SEND_ERROR },
    });
    expect(await system.run.count({ where: { botId } })).toBe(1);
  });

  it("lets a bare stop end active work without a model, and refuses it when idle", async () => {
    const thread = await system.thread.findFirstOrThrow({ where: { botId } });
    await expectRefused(await send({ botId, text: "stop" }));
    const work = { spaceId: actor.spaceId, botId, threadId: thread.id, userId: actor.userId };
    const task = await system.task.create({ data: { ...work, prompt: "work", status: "queued" } });
    const run = await system.run.create({
      data: { ...work, taskId: task.id, status: "running", trigger: "user" },
    });
    const notStop = await send({ botId, text: "stop please" });
    expect(notStop.status).toBe(400);
    expect(await notStop.json()).toMatchObject({
      json: { message: BOT_COMPUTER_REQUIRED_SEND_ERROR },
    });
    expect((await send({ botId, text: "Stop now" })).status).toBe(200);
    expect((await system.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "cancelled",
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(await userMessages(thread.id)).toBe(1);
  });

  it("lets a group send through only when every bot it wakes is on a computer", async () => {
    await system.bot.update({ where: { id: botId }, data: { name: "Alpha" } });
    await system.daemonMachine.create({
      data: {
        id: randomUUID(),
        userId: actor.userId,
        name: "Test computer",
        tokenHash: randomUUID(),
        connectionId: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        assignments: { create: { botId, cwd: "/test" } },
      },
    });
    const beta = await system.bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name: "Beta", color: "primary" },
    });
    const group = await system.chatGroup.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Group",
        members: { create: [{ botId }, { botId: beta.id }] },
        thread: { create: { spaceId: actor.spaceId, userId: actor.userId } },
      },
      include: { thread: true },
    });
    const expectUnbound = async (response: Response) => {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        json: { message: BOT_COMPUTER_REQUIRED_SEND_ERROR },
      });
    };

    expect((await send({ groupId: group.id, text: "@Alpha hello" })).status).toBe(200);
    await expectUnbound(await send({ groupId: group.id, text: "@Beta hello" }));
    await expectUnbound(await send({ groupId: group.id, text: "@everyone hello" }));
    await expectUnbound(
      await send({ groupId: group.id, text: "stop", mentions: [{ kind: "bot", id: beta.id }] }),
    );
    await expectUnbound(
      await send({ groupId: group.id, text: "hello", mentions: [{ kind: "bot", id: beta.id }] }),
    );
    await expectUnbound(await send({ groupId: group.id, text: "hello" }));
    expect(await userMessages(group.thread!.id)).toBe(1);
    const reply = (author: string) =>
      createThreadMessage(system, {
        threadId: group.thread!.id,
        role: "bot",
        botId: author,
        blocks: [{ kind: "text", text: "Which colour?" }],
      });
    const alphaReply = await reply(botId);
    const betaReply = await reply(beta.id);
    expect(
      (await send({ groupId: group.id, text: "blue", replyToMessageId: alphaReply.id })).status,
    ).toBe(200);
    await expectUnbound(
      await send({ groupId: group.id, text: "blue", replyToMessageId: betaReply.id }),
    );
    expect(await userMessages(group.thread!.id)).toBe(2);
    expect(await react({ groupId: group.id }, group.thread!.id, beta.id)).toEqual([]);
    expect(await react({ groupId: group.id }, group.thread!.id, botId)).toHaveLength(1);
  });
});
