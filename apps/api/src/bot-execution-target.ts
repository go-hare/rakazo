import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

export const daemonAssignmentSelection = {
  select: {
    machine: {
      select: {
        userId: true,
        revokedAt: true,
        connectionId: true,
        leaseExpiresAt: true,
        sessionId: true,
      },
    },
  },
} as const;

type Assignment = {
  machine: {
    userId: string;
    revokedAt: Date | null;
    connectionId: string | null;
    leaseExpiresAt: Date | null;
    sessionId: string | null;
  };
};

export type BotExecutionTarget = "server" | "local" | "unavailable";

export async function botExecutionTarget(
  prisma: PrismaClient,
  actor: Actor,
  assignment: Assignment | null | undefined,
): Promise<BotExecutionTarget> {
  if (!assignment) return "server";
  const machine = assignment.machine;
  if (machine.userId !== actor.userId) throw new ORPCError("FORBIDDEN");
  if (
    machine.revokedAt ||
    !machine.connectionId ||
    !machine.leaseExpiresAt ||
    machine.leaseExpiresAt.getTime() <= Date.now()
  )
    return "unavailable";
  if (
    machine.sessionId &&
    !(await prisma.session.findFirst({
      where: { id: machine.sessionId, userId: actor.userId, expiresAt: { gt: new Date() } },
      select: { id: true },
    }))
  )
    return "unavailable";
  return "local";
}

export async function localOnboardingBot(prisma: PrismaClient, actor: Actor) {
  const bots = await prisma.bot.findMany({
    where: {
      spaceId: actor.spaceId,
      archivedAt: null,
      space: { memberships: { some: { userId: actor.userId } } },
      daemonAssignment: { machine: { userId: actor.userId, revokedAt: null } },
    },
    select: { id: true, daemonAssignment: daemonAssignmentSelection },
    orderBy: { createdAt: "asc" },
  });
  for (const bot of bots) {
    if ((await botExecutionTarget(prisma, actor, bot.daemonAssignment)) === "local") return bot.id;
  }
  return undefined;
}
