import { RunJobPublisher } from "@rakazo/adapters";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { attachDaemonRuns } from "./daemon-machines.js";

vi.mock("@rakazo/adapters", () => ({
  RunJobPublisher: class {
    ownRun?: (runId: string) => Promise<boolean>;
    enqueue = vi.fn();
  },
  createMachines: vi.fn(),
}));

describe("daemon run dispatch", () => {
  it("lets the executor take a pinned queued run", async () => {
    const jobs = new (
      RunJobPublisher as unknown as new () => RunJobPublisher & {
        ownRun: (id: string) => Promise<boolean>;
      }
    )();
    const run = {
      id: "run",
      status: "queued",
      spaceId: "space",
      threadId: "thread",
      botId: "bot",
      taskId: "task",
      leaseFence: 3,
      leaseOwner: null,
      deviceId: null,
      deviceTurnId: null,
      attempts: [],
    };
    const prisma = { run: { findUnique: vi.fn(async () => run) } } as unknown as PrismaClient;
    const claim = vi.fn();
    const machines = {
      pinned: vi.fn(async () => ({ machineId: "machine" })),
      store: { claimUnavailableRun: claim },
    } as unknown as Parameters<typeof attachDaemonRuns>[2];
    const finalize = vi.fn();
    attachDaemonRuns(jobs, prisma, machines, { finalizeRun: finalize } as unknown as ThreadEvents);
    expect(await jobs.ownRun("run")).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("finishes an interrupted failure claim even after the machine is unpinned", async () => {
    const jobs = new (
      RunJobPublisher as unknown as new () => RunJobPublisher & {
        ownRun: (id: string) => Promise<boolean>;
      }
    )();
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run",
          status: "running",
          botId: "bot",
          spaceId: "space",
          threadId: "thread",
          taskId: "task",
          leaseOwner: "daemon-unavailable",
          leaseFence: 4,
          attempts: [{ id: "attempt", fence: 4 }],
        })),
      },
    } as unknown as PrismaClient;
    const pinned = vi.fn(async () => null);
    const machines = { pinned, store: {} } as unknown as Parameters<typeof attachDaemonRuns>[2];
    const finalize = vi.fn(async () => ({ continuationRunId: null }));
    attachDaemonRuns(jobs, prisma, machines, { finalizeRun: finalize } as unknown as ThreadEvents);
    expect(await jobs.ownRun("run")).toBe(true);
    expect(pinned).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "attempt", leaseFence: 4, outcome: "failed" }),
    );
  });

  it.each([
    { leaseOwner: "executor", deviceId: null, expected: false },
    { leaseOwner: "daemon", deviceId: "machine", expected: true },
    { leaseOwner: "daemon", deviceId: null, expected: true },
    { leaseOwner: null, deviceId: "machine", expected: true },
  ])(
    "uses the run owner and device for a running turn ($leaseOwner, $deviceId)",
    async ({ leaseOwner, deviceId, expected }) => {
      const jobs = new (
        RunJobPublisher as unknown as new () => RunJobPublisher & {
          ownRun: (id: string) => Promise<boolean>;
        }
      )();
      const prisma = {
        run: {
          findUnique: vi.fn(async () => ({
            status: "running",
            botId: "bot",
            leaseOwner,
            deviceId,
            attempts: [],
          })),
        },
      } as unknown as PrismaClient;
      const pinned = vi.fn(async () => ({ machineId: "new-machine" }));
      const claim = vi.fn();
      const machines = {
        pinned,
        store: { claimUnavailableRun: claim },
      } as unknown as Parameters<typeof attachDaemonRuns>[2];
      const finalize = vi.fn();
      attachDaemonRuns(jobs, prisma, machines, {
        finalizeRun: finalize,
      } as unknown as ThreadEvents);
      expect(await jobs.ownRun("run")).toBe(expected);
      expect(pinned).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
    },
  );

  it("leaves an already running daemon turn untouched after unpinning", async () => {
    const jobs = new (
      RunJobPublisher as unknown as new () => RunJobPublisher & {
        ownRun: (id: string) => Promise<boolean>;
      }
    )();
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          status: "running",
          botId: "bot",
          leaseOwner: "daemon",
          attempts: [],
        })),
      },
    } as unknown as PrismaClient;
    const claim = vi.fn();
    const machines = {
      pinned: vi.fn(async () => null),
      store: { claimUnavailableRun: claim },
    } as unknown as Parameters<typeof attachDaemonRuns>[2];
    const finalize = vi.fn();
    attachDaemonRuns(jobs, prisma, machines, { finalizeRun: finalize } as unknown as ThreadEvents);
    expect(await jobs.ownRun("run")).toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });
});
