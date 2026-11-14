import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createMachines } from "./daemon-machines-hub.js";

const store = vi.hoisted(() => ({
  issue: vi.fn(async () => ({ id: "machine", userId: "user", name: "computer", token: "secret" })),
  pin: vi.fn(async () => true),
  unpin: vi.fn(async () => true),
  pinned: vi.fn(async () => null),
  list: vi.fn(async () => []),
  assignments: vi.fn(async () => []),
  expiredConnections: vi.fn(async (): Promise<Array<{ id: string; connectionId: string }>> => []),
  machinesWithFailedTurns: vi.fn(async (): Promise<Array<{ machineId: string }>> => []),
  releaseConnection: vi.fn(async (_id: string, _connectionId: string, _expired?: boolean) => []),
  failedTurns: vi.fn(async (_machineId: string): Promise<string[]> => []),
  settleFailedTurn: vi.fn(async (_machineId: string, _turnId: string) => {}),
}));
vi.mock("@rakazo/db", () => ({
  createDaemonMachineStore: () => store,
  expireLiveDaemonAsks: vi.fn(async () => {}),
  expireOverdueLiveDaemonAsks: vi.fn(async () => {}),
}));

describe("daemon machine hub", () => {
  it("routes registration and binding through the shared store", async () => {
    const hub = createMachines({} as PrismaClient, vi.fn(), vi.fn());
    expect((await hub.issue("computer", "user")).id).toBe("machine");
    expect(await hub.pin("bot", "machine", "/work", undefined, "user")).toBe(true);
    expect(store.pin).toHaveBeenCalledWith("user", "bot", "machine", "/work", undefined);
    await hub.unpin("bot", "user");
    expect(store.unpin).toHaveBeenCalledWith("user", "bot");
  });

  it("keeps recovering other machines and turns while work hangs or fails", async () => {
    vi.useFakeTimers();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    store.expiredConnections.mockResolvedValue([
      { id: "blocked", connectionId: "old" },
      { id: "other", connectionId: "old" },
    ]);
    store.releaseConnection.mockImplementation(async (id) => {
      if (id === "blocked") await blocked;
      return [];
    });
    store.machinesWithFailedTurns.mockResolvedValue([
      { machineId: "blocked" },
      { machineId: "other" },
    ]);
    store.failedTurns.mockImplementation(async (id) =>
      id === "blocked" ? ["slow", "bad", "good"] : ["other"],
    );
    const onFailed = vi.fn(async (_machineId: string, turnId: string) => {
      if (turnId === "slow") await blocked;
      if (turnId === "bad") throw new Error("failed turn");
    });
    try {
      createMachines({} as PrismaClient, vi.fn(), onFailed);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.releaseConnection).toHaveBeenCalledWith("other", "old", true);
      expect(store.settleFailedTurn).toHaveBeenCalledWith("blocked", "good");
      expect(store.settleFailedTurn).toHaveBeenCalledWith("other", "other");
      expect(store.settleFailedTurn).not.toHaveBeenCalledWith("blocked", "bad");
      store.machinesWithFailedTurns.mockResolvedValue([
        { machineId: "new" },
        { machineId: "blocked" },
      ]);
      store.failedTurns.mockImplementation(async (id) =>
        id === "blocked" ? ["slow", "bad"] : ["new"],
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.settleFailedTurn).toHaveBeenCalledWith("new", "new");
      expect(
        onFailed.mock.calls.filter(([id, turn]) => id === "blocked" && turn === "bad"),
      ).toHaveLength(2);
      expect(
        onFailed.mock.calls.filter(([id, turn]) => id === "blocked" && turn === "slow"),
      ).toHaveLength(1);
      expect(store.releaseConnection.mock.calls.filter(([id]) => id === "blocked")).toHaveLength(1);
      unblock();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.settleFailedTurn).toHaveBeenCalledWith("blocked", "slow");
    } finally {
      unblock();
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.clearAllMocks();
    }
  });

  it("escapes closing script tags in login data", () => {
    const hub = createMachines({} as PrismaClient, vi.fn(), vi.fn());
    const page = hub.loginPage("http://127.0.0.1:1234/", "</script><script>alert(1)</script>");
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page).toContain("\\u003c/script>");
  });
});
