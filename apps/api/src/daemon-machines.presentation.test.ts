import type { PrismaClient } from "@rakazo/db";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  frame: null as null | ((frame: Record<string, unknown>) => Promise<void>),
  finalize: vi.fn(),
  append: vi.fn(),
}));
vi.mock("@rakazo/adapters", () => ({
  createMachines: (_prisma: unknown, frame: typeof mocks.frame) => {
    mocks.frame = frame;
    return {};
  },
  RunJobPublisher: class {},
}));
vi.mock("@rakazo/db", () => ({
  createLiveDaemonAsk: vi.fn(),
  finalizeRun: mocks.finalize,
  runAsSystem: vi.fn(),
  runAsTenant: vi.fn(),
}));

import { startDaemonMachines } from "./daemon-machines.js";

beforeEach(() => {
  vi.clearAllMocks();
});

it("keeps deduplicated tool steps in streaming snapshots and the durable final reply", async () => {
  const run = {
    id: "run",
    spaceId: "space",
    threadId: "thread",
    botId: "bot",
    taskId: "task",
    leaseOwner: "daemon",
    leaseFence: 2,
    attempts: [{ id: "attempt", fence: 2 }],
  };
  const prisma = { run: { findFirst: vi.fn().mockResolvedValue(run) } } as unknown as PrismaClient;
  startDaemonMachines("", prisma, { append: mocks.append, notify: vi.fn() });
  const frame = async (data: Record<string, unknown>) =>
    mocks.frame!({ machineId: "machine", threadId: "thread", turnId: "turn", ...data });
  await frame({ type: "tool", itemId: "tool-1", title: "Bash", phase: "started" });
  await frame({ type: "tool", itemId: "tool-1", title: "Bash", phase: "started" });
  expect(mocks.append).toHaveBeenCalledTimes(1);
  expect(mocks.append.mock.calls[0]?.[0].payload.blocks).toEqual([
    { kind: "steps", steps: [{ label: "Bash", count: 1, note: "Running" }] },
  ]);
  await frame({ type: "tool", itemId: "tool-1", title: "Bash", phase: "completed", ok: true });
  await frame({ type: "delta", text: "Done." });
  await frame({ type: "done", ok: true });
  expect(mocks.finalize).toHaveBeenCalledWith(
    prisma,
    expect.objectContaining({
      outcome: "completed",
      blocks: [
        { kind: "steps", steps: [{ label: "Bash", count: 1 }] },
        { kind: "text", text: "Done." },
      ],
    }),
  );
});

it("reports malformed images in chat instead of silently replacing them with a placeholder", async () => {
  const run = { id: "run", spaceId: "space", threadId: "thread", botId: "bot", userId: "user" };
  const prisma = { run: { findFirst: vi.fn().mockResolvedValue(run) } } as unknown as PrismaClient;
  startDaemonMachines("", prisma, { append: mocks.append, notify: vi.fn() });
  await mocks.frame!({
    type: "image",
    machineId: "machine",
    threadId: "thread",
    turnId: "turn",
    mime: "image/png",
    data: "bad",
  });
  expect(mocks.append.mock.calls[0]?.[0].payload.blocks).toEqual([
    { kind: "text", text: "Presentation failed: Artifact storage is unavailable" },
  ]);
});
