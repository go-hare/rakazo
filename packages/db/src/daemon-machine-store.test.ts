import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDaemonMachineStore } from "./daemon-machine-store.js";

describe("daemon session binding", () => {
  it("rejects an invalid session and preserves legacy issuance", async () => {
    const query = vi.fn(async () => []);
    const create = vi.fn(async () => ({}));
    const store = createDaemonMachineStore({
      $queryRaw: query,
      daemonMachine: { create },
    } as unknown as PrismaClient);
    await expect(store.issue("user", "desktop", "invalid")).rejects.toThrow(
      "Invalid daemon session",
    );
    expect(create).not.toHaveBeenCalled();
    const legacy = await store.issue("user", "CLI");
    expect(legacy.token).toHaveLength(64);
    expect(create).toHaveBeenCalledOnce();
  });

  it("revokes by token without authenticating the session", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const query = vi.fn(async () => [{ id: "machine" }]);
    const store = createDaemonMachineStore({
      $transaction: async (fn: (tx: unknown) => unknown) =>
        fn({ $queryRaw: query, daemonCommand: { updateMany } }),
    } as unknown as PrismaClient);
    expect(await store.revokeToken("token")).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { machineId: "machine", status: { in: ["pending", "sending", "acknowledged"] } },
      data: { status: "uncertain" },
    });
  });
});

describe("daemon run claims", () => {
  it("claims only a queued run once and never changes a running turn", async () => {
    let status = "queued";
    const updateMany = vi.fn(async ({ where }: { where: { status: string } }) => {
      if (status !== where.status) return { count: 0 };
      status = "running";
      return { count: 1 };
    });
    const create = vi.fn(async () => ({ id: "attempt" }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
      run: { findUnique: vi.fn(async () => ({ spaceId: "space" })), updateMany },
      attempt: { create },
    };
    const store = createDaemonMachineStore({
      $transaction: async (fn: (transaction: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaClient);
    const results = await Promise.all([
      store.claimUnavailableRun("run", 1),
      store.claimUnavailableRun("run", 1),
    ]);
    expect(results.filter(Boolean)).toEqual([{ attemptId: "attempt", fence: 2 }]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await store.claimUnavailableRun("old-running-turn", 1)).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("checks the Space before updating and includes the due time in the claim", async () => {
    const order: string[] = [];
    let deleting = true;
    const tx = {
      $queryRaw: vi.fn(async () => {
        order.push("lock");
      }),
      space: {
        findUnique: vi.fn(async () => {
          order.push("space");
          return { deletingAt: deleting ? new Date() : null };
        }),
      },
      run: {
        findUnique: vi.fn(async () => ({ spaceId: "space" })),
        updateMany: vi.fn(async () => {
          order.push("run");
          return { count: 0 };
        }),
      },
      attempt: { create: vi.fn() },
    };
    const store = createDaemonMachineStore({
      $transaction: async (fn: (transaction: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaClient);
    expect(await store.claimUnavailableRun("run", 3)).toBeNull();
    expect(order).toEqual(["lock", "space"]);
    deleting = false;
    expect(await store.claimUnavailableRun("run", 3)).toBeNull();
    expect(order.slice(2)).toEqual(["lock", "space", "run"]);
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "run",
          spaceId: "space",
          status: "queued",
          leaseFence: 3,
          OR: [{ wakeAt: null }, { wakeAt: { lte: expect.any(Date) } }],
        },
      }),
    );
    expect(tx.attempt.create).not.toHaveBeenCalled();
  });

  it("leaves the unused combined claim path disabled", async () => {
    const transaction = vi.fn();
    const store = createDaemonMachineStore({
      $transaction: transaction,
    } as unknown as PrismaClient);
    const result = await store.claimRunAndEnqueue({
      machineId: "machine",
      spaceId: "space",
      threadId: "thread",
      turnId: "turn",
      type: "turn",
      payload: { text: "test" },
      expiresAt: new Date(),
      runId: "run",
      leaseFence: 0,
      leaseExpiresAt: new Date(),
    });
    expect(result).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("submits a turn only when the bot is idle and the fenced run still owns it", async () => {
    const order: string[] = [];
    let queries = 0;
    const tx = {
      $queryRaw: vi.fn(async () => {
        queries += 1;
        if (queries === 1) {
          order.push("lock");
          return [];
        }
        if (queries === 2) {
          order.push("bot");
          return [{ daemonUncertainUntil: null }];
        }
        if (queries === 3) return [];
        return [{ id: "row" }];
      }),
      space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
      daemonAssignment: { findFirst: vi.fn(async () => ({ botId: "bot" })) },
      attempt: { findFirst: vi.fn(async () => ({ id: "attempt" })) },
      run: {
        updateMany: vi.fn(async () => {
          order.push("run");
          return { count: 1 };
        }),
      },
      $executeRaw: vi.fn(async () => 1),
    };
    const store = createDaemonMachineStore({
      $transaction: async (fn: (transaction: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaClient);
    await expect(
      store.submitTurn({
        runId: "run",
        attemptId: "attempt",
        leaseOwner: "worker",
        leaseFence: 2,
        botId: "bot",
        spaceId: "space",
        threadId: "thread",
        userId: "user",
        machineId: "machine",
        turnId: "turn",
        payload: { text: "hi" },
      }),
    ).rejects.toThrow("Daemon commands require content encryption");
    expect(order).toEqual(["lock", "bot", "run"]);
  });

  it("does not submit while another machine turn may still be running", async () => {
    const updateMany = vi.fn();
    let queries = 0;
    const tx = {
      $queryRaw: vi.fn(async () => {
        queries += 1;
        if (queries === 2) return [{ daemonUncertainUntil: new Date(Date.now() + 60_000) }];
        return [];
      }),
      space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
      run: { updateMany },
    };
    const store = createDaemonMachineStore({
      $transaction: async (fn: (transaction: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaClient);
    expect(
      await store.submitTurn({
        runId: "run",
        attemptId: "attempt",
        leaseOwner: "worker",
        leaseFence: 2,
        botId: "bot",
        spaceId: "space",
        threadId: "thread",
        userId: "user",
        machineId: "machine",
        turnId: "turn",
        payload: { text: "hi" },
      }),
    ).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not submit while another run on the bot still holds a machine turn", async () => {
    const updateMany = vi.fn();
    let queries = 0;
    const tx = {
      $queryRaw: vi.fn(async () => {
        queries += 1;
        if (queries === 2) return [{ daemonUncertainUntil: null }];
        if (queries === 3) return [{ id: "other-run" }];
        return [];
      }),
      space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
      run: { updateMany },
    };
    const store = createDaemonMachineStore({
      $transaction: async (fn: (transaction: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaClient);
    expect(
      await store.submitTurn({
        runId: "run",
        attemptId: "attempt",
        leaseOwner: "worker",
        leaseFence: 2,
        botId: "bot",
        spaceId: "space",
        threadId: "thread",
        userId: "user",
        machineId: "machine",
        turnId: "turn",
        payload: { text: "hi" },
      }),
    ).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
