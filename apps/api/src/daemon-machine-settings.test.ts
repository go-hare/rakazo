import { createMachines } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountDaemonMachines } from "./daemon-machines.js";

function setup(signedIn = true) {
  const bots = [
    { id: "bot", spaceId: "space", memberId: "user" },
    { id: "second-bot", spaceId: "second-space", memberId: "user" },
    { id: "other-bot", spaceId: "other-space", memberId: "other-user" },
  ];
  const machines = [
    { id: "machine", userId: "user", name: "Computer", leaseExpiresAt: null },
    { id: "other-machine", userId: "other-user", name: "Other", leaseExpiresAt: null },
  ];
  type Assignment = { botId: string; machineId: string; cwd: string; agent: string | null };
  const assignments = new Map<string, Assignment>([
    ["second-bot", { botId: "second-bot", machineId: "machine", cwd: "/second", agent: null }],
    ["other-bot", { botId: "other-bot", machineId: "other-machine", cwd: "/other", agent: null }],
  ]);
  const accessible = (botId: string, userId: string) => {
    const context = currentDbContext();
    expect(context, "bot access requires an RLS context").toBeDefined();
    return bots.find(
      (bot) =>
        bot.id === botId &&
        bot.memberId === userId &&
        (context?.kind === "system" ||
          (context?.spaceId === bot.spaceId && context.userId === userId)),
    );
  };
  type MembershipFilter = { space: { memberships: { some: { userId: string } } } };
  const prisma = {
    bot: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } & MembershipFilter }) =>
        accessible(where.id, where.space.memberships.some.userId),
      ),
    },
    daemonMachine: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        machines.filter((machine) => machine.userId === where.userId),
      ),
    },
    daemonAssignment: {
      upsert: vi.fn(async ({ create, update }: { create: Assignment; update: Assignment }) => {
        expect(currentDbContext()).toEqual({ kind: "tenant", spaceId: "space", userId: "user" });
        assignments.set(
          create.botId,
          assignments.has(create.botId) ? { ...create, ...update } : create,
        );
      }),
      deleteMany: vi.fn(async ({ where }: { where: { botId: string; bot: MembershipFilter } }) => {
        expect(currentDbContext()).toEqual({ kind: "tenant", spaceId: "space", userId: "user" });
        return {
          count:
            accessible(where.botId, where.bot.space.memberships.some.userId) &&
            assignments.delete(where.botId)
              ? 1
              : 0,
        };
      }),
      findMany: vi.fn(
        async ({ where }: { where: { machine: { userId: string }; bot: MembershipFilter } }) =>
          [...assignments.values()].filter(
            (pin) =>
              machines.some(
                (machine) =>
                  machine.id === pin.machineId && machine.userId === where.machine.userId,
              ) && accessible(pin.botId, where.bot.space.memberships.some.userId),
          ),
      ),
    },
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, machineId: string, userId: string) =>
      machines.filter((machine) => machine.id === machineId && machine.userId === userId),
    ),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      expect(currentDbContext()).toEqual({ kind: "tenant", spaceId: "space", userId: "user" });
      return fn(prisma);
    }),
  };
  const client = prisma as unknown as PrismaClient;
  const hub = createMachines(client, vi.fn(), vi.fn());
  const app = new Hono();
  mountDaemonMachines(app, hub, async () => (signedIn ? { userId: "user" } : null), client);
  const save = (botId: string, body: Record<string, unknown>) =>
    app.request(`/api/bots/${botId}/machine`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, save, assignments, prisma };
}

describe("daemon machine settings", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("saves, lists across the account's spaces, updates, and clears a binding", async () => {
    const { app, save, assignments } = setup();
    const saved = await save("bot", { machineId: "machine", cwd: "/work", agent: "codex" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true });
    expect(assignments.get("bot")).toEqual({
      botId: "bot",
      machineId: "machine",
      cwd: "/work",
      agent: "codex",
    });
    const listed = await app.request("/api/machines");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      machines: [{ id: "machine", name: "Computer", online: false, cwd: "/second" }],
      pins: {
        bot: { machineId: "machine", cwd: "/work", agent: "codex" },
        "second-bot": { machineId: "machine", cwd: "/second" },
      },
    });
    expect(currentDbContext()).toBeUndefined();
    expect((await save("bot", { machineId: "machine", cwd: "/updated" })).status).toBe(200);
    expect(assignments.get("bot")).toMatchObject({ cwd: "/updated", agent: null });
    expect((await save("bot", { machineId: "" })).status).toBe(200);
    expect(assignments.has("bot")).toBe(false);
    expect((await save("bot", { machineId: "" })).status).toBe(200);
    expect(assignments.get("other-bot")?.cwd).toBe("/other");
    expect(currentDbContext()).toBeUndefined();
  });

  it.each([{ machineId: "machine", cwd: "/work" }, { machineId: "" }])(
    "rejects another account's bot when saving or clearing ($machineId)",
    async (body) => {
      const { save, assignments, prisma } = setup();
      expect((await save("other-bot", body)).status).toBe(404);
      expect(assignments.get("other-bot")?.cwd).toBe("/other");
      expect(prisma.daemonAssignment.upsert).not.toHaveBeenCalled();
      expect(prisma.daemonAssignment.deleteMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    { machineId: "other-machine", cwd: "/work" },
    { machineId: "missing", cwd: "/work" },
    { machineId: "machine", cwd: "" },
  ])("rejects an unavailable machine or empty directory ($machineId, $cwd)", async (body) => {
    const { save, assignments } = setup();
    expect((await save("bot", body)).status).toBe(400);
    expect(assignments.has("bot")).toBe(false);
  });

  it("requires login for listing, saving, and clearing", async () => {
    const { app, save, prisma } = setup(false);
    expect((await app.request("/api/machines")).status).toBe(401);
    expect((await save("bot", { machineId: "machine", cwd: "/work" })).status).toBe(401);
    expect((await save("bot", { machineId: "" })).status).toBe(401);
    expect(prisma.bot.findFirst).not.toHaveBeenCalled();
    expect(prisma.daemonAssignment.upsert).not.toHaveBeenCalled();
    expect(prisma.daemonAssignment.deleteMany).not.toHaveBeenCalled();
  });
});
