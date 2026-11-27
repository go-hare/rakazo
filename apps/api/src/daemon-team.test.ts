import { messageBot } from "@rakazo/adapters";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleDaemonTeam } from "./daemon-team.js";

vi.mock("@rakazo/adapters", () => ({
  messageBot: vi.fn(),
  handoffToGroupBot: vi.fn(),
}));

const push = vi.fn();
const events = { append: vi.fn(), notify: vi.fn() } as unknown as ThreadEvents;
const jobs = { enqueue: vi.fn(), cancel: vi.fn(), close: vi.fn() };

const run = {
  id: "run",
  spaceId: "space",
  threadId: "thread",
  botId: "sender",
  userId: "user",
  sourceMessageId: null,
  bot: { name: "Chief" },
  thread: { groupId: "group" },
};

function prismaFor(found: typeof run | null) {
  return {
    run: { findFirst: vi.fn().mockResolvedValue(found) },
    bot: {
      findMany: vi.fn().mockResolvedValue([
        { id: "sender", name: "Chief", description: "Lead" },
        { id: "peer", name: "Ops", description: "Ops" },
      ]),
    },
    chatGroup: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "group",
          name: "Desk",
          members: [{ bot: { id: "sender", name: "Chief" } }, { bot: { id: "peer", name: "Ops" } }],
        },
      ]),
    },
  } as unknown as PrismaClient;
}

describe("daemon team actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists bots and groups for the active turn", async () => {
    const prisma = prismaFor(run);
    await handleDaemonTeam({
      prisma,
      events,
      jobs,
      push,
      frame: {
        type: "team",
        machineId: "machine",
        threadId: "thread",
        turnId: "turn",
        requestId: "req",
        tool: "list_fleet",
        input: {},
      },
    });
    expect(push).toHaveBeenCalledWith(
      "machine",
      expect.objectContaining({
        type: "team_result",
        requestId: "req",
        ok: true,
      }),
    );
    const payload = push.mock.calls[0]?.[1] as { text: string };
    expect(JSON.parse(payload.text)).toEqual({
      bots: [
        { id: "sender", name: "Chief", description: "Lead" },
        { id: "peer", name: "Ops", description: "Ops" },
      ],
      groups: [
        {
          id: "group",
          name: "Desk",
          members: [
            { id: "sender", name: "Chief" },
            { id: "peer", name: "Ops" },
          ],
        },
      ],
    });
  });

  it("delivers message_bot through the shared sender", async () => {
    vi.mocked(messageBot).mockResolvedValue({
      ok: true,
      botId: "peer",
      name: "Ops",
      delivered: "hello",
      note: "sent",
    });
    await handleDaemonTeam({
      prisma: prismaFor(run),
      events,
      jobs,
      push,
      frame: {
        type: "team",
        machineId: "machine",
        threadId: "thread",
        turnId: "turn",
        requestId: "req-2",
        tool: "message_bot",
        input: { confirm_name: "Ops", message: "hello" },
      },
    });
    expect(messageBot).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), jobs }),
      expect.objectContaining({ id: "run", botId: "sender" }),
      { id: "sender", name: "Chief" },
      expect.objectContaining({
        confirm_name: "Ops",
        message: "hello",
        deliveryKey: "req-2",
      }),
    );
    expect(push.mock.calls[0]?.[1]).toMatchObject({ ok: true, requestId: "req-2" });
  });

  it("rejects an unknown team tool", async () => {
    await handleDaemonTeam({
      prisma: prismaFor(run),
      events,
      jobs,
      push,
      frame: {
        type: "team",
        machineId: "machine",
        threadId: "thread",
        turnId: "turn",
        requestId: "req-3",
        tool: "create_group",
        input: {},
      },
    });
    expect(push).toHaveBeenCalledWith(
      "machine",
      expect.objectContaining({
        ok: false,
        requestId: "req-3",
        text: "Unknown team tool: create_group",
      }),
    );
    expect(messageBot).not.toHaveBeenCalled();
  });
});
