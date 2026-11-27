import type { Actor } from "@rakazo/contracts";
import { BOT_COMPUTER_REQUIRED_SEND_ERROR, userErrorMessage } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { botExecutionTarget, localOnboardingBot } from "./bot-execution-target.js";
import type { RouterDeps } from "./router.js";
import { botsCanRun } from "./routes/shared.js";

const actor = { userId: "owner", spaceId: "space" } as Actor;
const assignment = () => ({
  machine: {
    userId: actor.userId,
    revokedAt: null as Date | null,
    connectionId: "connection",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    sessionId: null as string | null,
  },
});
function fixture(pin: ReturnType<typeof assignment> | null = assignment()) {
  const bot = {
    id: "local-bot",
    daemonAssignment: pin,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
  };
  const prisma = {
    bot: { findMany: vi.fn().mockResolvedValue([bot]) },
    session: { findFirst: vi.fn().mockResolvedValue({ id: "session" }) },
  };
  return { bot, prisma, deps: { prisma } as unknown as RouterDeps };
}

describe("authoritative bot execution target", () => {
  it("runs a bound bot without any model or secret store", async () => {
    const { deps, prisma } = fixture();
    await expect(botsCanRun(deps, actor, ["local-bot"], false)).resolves.toBe(true);
    expect(prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["local-bot"] },
          spaceId: actor.spaceId,
          space: { memberships: { some: { userId: actor.userId } } },
        }),
      }),
    );
  });

  it("refuses unbound bots instead of falling back to the server executor", async () => {
    const { deps } = fixture(null);
    await expect(botsCanRun(deps, actor, ["server-bot"], false)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: BOT_COMPUTER_REQUIRED_SEND_ERROR,
    });
    await expect(botsCanRun(deps, actor, ["server-bot"], true)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: BOT_COMPUTER_REQUIRED_SEND_ERROR,
    });
    await expect(botsCanRun(deps, actor, ["server-bot"], true, "skip")).resolves.toBe(false);
  });

  it("does not let a local recipient exempt a server recipient", async () => {
    const { deps, prisma, bot } = fixture();
    prisma.bot.findMany.mockResolvedValue([
      bot,
      { ...bot, id: "server-bot", daemonAssignment: null },
    ]);
    await expect(botsCanRun(deps, actor, ["local-bot", "server-bot"], false)).rejects.toMatchObject(
      {
        code: "BAD_REQUEST",
        message: BOT_COMPUTER_REQUIRED_SEND_ERROR,
      },
    );
  });

  it("allows an empty recipient set without granting access to a bot", async () => {
    const { deps, prisma } = fixture();
    prisma.bot.findMany.mockResolvedValue([]);
    await expect(botsCanRun(deps, actor, [], false)).resolves.toBe(true);
    await expect(
      botsCanRun(deps, actor, ["inaccessible-bot"], false, "skip"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("preserves the reconnect action in shared web and mobile error copy", () => {
    const message = "Reconnect this bot's computer and try again.";
    expect(userErrorMessage(new Error(message), { fallback: "Failed", offline: "Offline" })).toBe(
      message,
    );
  });

  it("rejects another user's bound machine even when a main model exists", async () => {
    const pin = assignment();
    pin.machine.userId = "other-user";
    const { deps } = fixture(pin);
    await expect(botsCanRun(deps, actor, ["local-bot"], true)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(botsCanRun(deps, actor, ["local-bot"], true, "skip")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects bots outside the caller's membership", async () => {
    const { deps, prisma } = fixture();
    prisma.bot.findMany.mockResolvedValue([]);
    await expect(botsCanRun(deps, actor, ["inaccessible-bot"], false)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it.each(["offline", "revoked", "expired-session"])(
    "asks to reconnect an %s computer without falling back",
    async (reason) => {
      const pin = assignment();
      if (reason === "offline") pin.machine.leaseExpiresAt = new Date(0);
      if (reason === "revoked") pin.machine.revokedAt = new Date();
      if (reason === "expired-session") pin.machine.sessionId = "session";
      const { deps, prisma } = fixture(pin);
      prisma.session.findFirst.mockResolvedValue(null as never);
      await expect(botsCanRun(deps, actor, ["local-bot"], true)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Reconnect this bot's computer and try again.",
      });
      await expect(botsCanRun(deps, actor, ["local-bot"], true, "skip")).resolves.toBe(false);
    },
  );

  it("rechecks the binding on each send", async () => {
    const { deps, prisma, bot } = fixture();
    await expect(botsCanRun(deps, actor, [bot.id], false)).resolves.toBe(true);
    prisma.bot.findMany.mockResolvedValue([{ ...bot, daemonAssignment: null }]);
    await expect(botsCanRun(deps, actor, [bot.id], false)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: BOT_COMPUTER_REQUIRED_SEND_ERROR,
    });
  });

  it("returns only an available own bot for onboarding", async () => {
    const { prisma } = fixture();
    await expect(localOnboardingBot(prisma as unknown as PrismaClient, actor)).resolves.toBe(
      "local-bot",
    );
    expect(prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: actor.spaceId,
          daemonAssignment: { machine: { userId: actor.userId, revokedAt: null } },
        }),
      }),
    );
    const offline = assignment();
    offline.machine.leaseExpiresAt = new Date(0);
    await expect(
      botExecutionTarget(prisma as unknown as PrismaClient, actor, offline),
    ).resolves.toBe("unavailable");
  });
});
