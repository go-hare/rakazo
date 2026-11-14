import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { answerLiveDaemonAsk, createLiveDaemonAsk } from "./daemon-live-ask.js";

vi.mock("./content-encryption.js", () => ({ contentEncryptionOf: () => undefined }));
vi.mock("./event-stream.js", () => ({ notifyRealtime: vi.fn() }));
vi.mock("./events.js", () => ({ appendEventInTransaction: vi.fn() }));
vi.mock("./messages.js", () => ({ createThreadMessageInTransaction: vi.fn() }));
vi.mock("./daemon-machine-store.js", () => ({ createDaemonMachineStore: vi.fn() }));
vi.mock("./security-events.js", () => ({ recordSecurityEvent: vi.fn() }));

describe("live daemon asks", () => {
  it("rejects secret cards and already-authored approval effects", async () => {
    const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;
    expect(
      await createLiveDaemonAsk(prisma, {
        spaceId: "space",
        threadId: "thread",
        runId: "run",
        attemptId: "attempt",
        leaseFence: 1,
        machineId: "machine",
        connectionId: "connection",
        turnId: "turn",
        requestId: "request",
        expiresAt: new Date(Date.now() + 60_000),
        kind: "permission",
        block: {
          kind: "ask",
          text: "run this",
          input: "secret",
          status: "pending",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      }),
    ).toBeNull();
    expect(
      await createLiveDaemonAsk(prisma, {
        spaceId: "space",
        threadId: "thread",
        runId: "run",
        attemptId: "attempt",
        leaseFence: 1,
        machineId: "machine",
        connectionId: "connection",
        turnId: "turn",
        requestId: "request",
        expiresAt: new Date(Date.now() + 60_000),
        kind: "question",
        block: {
          kind: "ask",
          text: "what next",
          actions: [{ id: "allow", label: "Allow once" }],
        },
      }),
    ).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not treat secret, login, or dismiss answers as live machine replies", async () => {
    const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;
    const base = {
      spaceId: "space",
      threadId: "thread",
      runId: "run",
      messageId: "message",
      answeredByUserId: "user",
    };
    expect(await answerLiveDaemonAsk(prisma, { ...base, answer: "secret", dismiss: true })).toBe(
      false,
    );
    expect(
      await answerLiveDaemonAsk(prisma, {
        ...base,
        answer: "x",
        fields: [{ label: "u", value: "v", hidden: false }],
      }),
    ).toBe(false);
    expect(await answerLiveDaemonAsk(prisma, { ...base, answer: "x", username: "u" })).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
