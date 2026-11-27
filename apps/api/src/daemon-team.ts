import type { JobPublisher } from "@rakazo/adapter-kit";
import { handoffToGroupBot, messageBot } from "@rakazo/adapters";
import { BotMessageIntent } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";

const TEAM_TOOLS = new Set(["list_fleet", "message_bot", "handoff_to_bot"]);
const FLEET_BOT_LIMIT = 40;
const FLEET_GROUP_LIMIT = 20;

export async function handleDaemonTeam(input: {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "append" | "notify">;
  jobs?: JobPublisher;
  push: (machineId: string, frame: Record<string, unknown>) => boolean;
  frame: Record<string, unknown>;
}): Promise<void> {
  const machineId = stringOf(input.frame.machineId);
  const threadId = stringOf(input.frame.threadId);
  const turnId = stringOf(input.frame.turnId);
  const requestId = stringOf(input.frame.requestId);
  const tool = stringOf(input.frame.tool);
  if (!machineId || !threadId || !turnId || !requestId || !tool) return;
  const reply = (ok: boolean, text: string) =>
    input.push(machineId, {
      type: "team_result",
      threadId,
      turnId,
      requestId,
      ok,
      text,
    });
  if (!TEAM_TOOLS.has(tool)) {
    reply(false, `Unknown team tool: ${tool}`);
    return;
  }
  const args =
    input.frame.input && typeof input.frame.input === "object" && !Array.isArray(input.frame.input)
      ? (input.frame.input as Record<string, unknown>)
      : {};
  try {
    const run = await input.prisma.run.findFirst({
      where: { deviceId: machineId, deviceTurnId: turnId, status: "running" },
      select: {
        id: true,
        spaceId: true,
        threadId: true,
        botId: true,
        userId: true,
        sourceMessageId: true,
        bot: { select: { name: true } },
        thread: { select: { groupId: true } },
      },
    });
    if (!run?.bot) {
      reply(false, "No active turn");
      return;
    }
    if (run.threadId !== threadId) {
      reply(false, "Turn does not match this chat");
      return;
    }
    const text = await runTeamTool(input, run, tool, { ...args, deliveryKey: requestId });
    reply(true, text);
  } catch (error) {
    reply(false, error instanceof Error ? error.message : String(error));
  }
}

async function runTeamTool(
  input: {
    prisma: PrismaClient;
    events: Pick<ThreadEvents, "append" | "notify">;
    jobs?: JobPublisher;
  },
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId: string | null;
    bot: { name: string };
    thread: { groupId: string | null } | null;
  },
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (tool === "list_fleet") return JSON.stringify(await listTeammates(input.prisma, run));
  if (!input.jobs) throw new Error("Team actions are unavailable on this server.");
  const deps = {
    prisma: input.prisma,
    events: input.events as ThreadEvents,
    jobs: input.jobs,
  };
  const sender = { id: run.botId, name: run.bot.name };
  if (tool === "message_bot") {
    const message = stringOf(args.message)?.trim() ?? "";
    const sent = await messageBot(deps, run, sender, {
      bot_id: stringOf(args.bot_id),
      confirm_name: stringOf(args.confirm_name),
      message,
      intent: intentOf(args.intent),
      deliveryKey: stringOf(args.deliveryKey) ?? undefined,
    });
    if (!sent.ok) throw new Error(sent.error);
    return JSON.stringify({
      ok: true,
      botId: sent.botId,
      name: sent.name,
      note: sent.note,
    });
  }
  const groupId = stringOf(args.group_id)?.trim() || run.thread?.groupId;
  if (!groupId) throw new Error("group_id is required outside a group chat");
  const handed = await handoffToGroupBot(deps, run, groupId, {
    bot_id: stringOf(args.bot_id),
    confirm_name: stringOf(args.confirm_name),
    message: stringOf(args.message)?.trim() ?? "",
    deliveryKey: stringOf(args.deliveryKey) ?? undefined,
  });
  if ("error" in handed) throw new Error(handed.error);
  return JSON.stringify(handed);
}

async function listTeammates(
  prisma: PrismaClient,
  run: { spaceId: string; botId: string },
): Promise<{ bots: Array<{ id: string; name: string; description: string }>; groups: unknown[] }> {
  const [bots, groups] = await Promise.all([
    prisma.bot.findMany({
      where: { spaceId: run.spaceId, archivedAt: null },
      select: { id: true, name: true, description: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: FLEET_BOT_LIMIT + 1,
    }),
    prisma.chatGroup.findMany({
      where: { spaceId: run.spaceId, archivedAt: null },
      select: {
        id: true,
        name: true,
        members: {
          where: { bot: { archivedAt: null } },
          select: { bot: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: FLEET_GROUP_LIMIT + 1,
    }),
  ]);
  return {
    bots: bots.slice(0, FLEET_BOT_LIMIT).map((bot) => ({
      id: bot.id,
      name: bot.name,
      description: bot.description,
    })),
    groups: groups.slice(0, FLEET_GROUP_LIMIT).map((group) => ({
      id: group.id,
      name: group.name,
      members: group.members.map((member) => ({
        id: member.bot.id,
        name: member.bot.name,
      })),
    })),
  };
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function intentOf(value: unknown) {
  const parsed = BotMessageIntent.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
