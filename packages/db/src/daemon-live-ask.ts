import { randomUUID } from "node:crypto";
import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  MessageBlock as MessageBlockSchema,
  THREAD_MESSAGE_TEXT_MAX_LENGTH,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { createDaemonMachineStore } from "./daemon-machine-store.js";
import { notifyRealtime } from "./event-stream.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { recordSecurityEvent } from "./security-events.js";
import type { AnswerRunInput } from "./thread-ask.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "./transaction-retry.js";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;
export interface CreateLiveDaemonAskInput {
  spaceId: string;
  threadId: string;
  runId: string;
  attemptId: string;
  leaseFence: number;
  machineId: string;
  connectionId: string;
  turnId: string;
  requestId: string;
  expiresAt: Date;
  kind: "permission" | "question";
  block: AskBlock;
}

/** The thread and run locks serialize with cancellation and ordinary answer transactions. */
async function activeRun(tx: Prisma.TransactionClient, input: CreateLiveDaemonAskInput) {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
  const runs = await tx.$queryRaw<Array<{ botId: string; userId: string }>>`
    SELECT r."botId", r."userId" FROM runs r
    JOIN attempts a ON a.id = ${input.attemptId} AND a."runId" = r.id
    WHERE r.id = ${input.runId} AND r."spaceId" = ${input.spaceId}
      AND r."threadId" = ${input.threadId} AND r.status = 'running'
      AND r."deviceId" = ${input.machineId} AND r."deviceTurnId" = ${input.turnId}
      AND r."leaseFence" = ${input.leaseFence} AND r."leaseExpiresAt" > clock_timestamp()
      AND a.fence = ${input.leaseFence} AND a.status = 'running'
    FOR UPDATE OF r`;
  const run = runs[0];
  if (!run) return null;
  const members = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT sm.id FROM space_members sm JOIN "user" u ON u.id = sm."userId"
    WHERE sm."spaceId" = ${input.spaceId} AND sm."userId" = ${run.userId}
      AND u."deactivatedAt" IS NULL FOR SHARE OF sm, u`;
  if (!members.length) return null;
  const machines = await tx.$queryRaw<Array<{ id: string; sessionId: string | null }>>`
    SELECT id, "sessionId" FROM daemon_machines WHERE id = ${input.machineId}
      AND "userId" = ${run.userId} AND "connectionId" = ${input.connectionId}
      AND "revokedAt" IS NULL AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`;
  const machine = machines[0];
  if (!machine) return null;
  if (machine.sessionId) {
    const sessions = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "session" WHERE id = ${machine.sessionId} AND "userId" = ${run.userId}
        AND "expiresAt" > clock_timestamp() FOR SHARE`;
    if (!sessions.length) return null;
  }
  const turns = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM daemon_commands WHERE "machineId" = ${input.machineId}
      AND "connectionId" = ${input.connectionId} AND "turnId" = ${input.turnId}
      AND "threadId" = ${input.threadId} AND "spaceId" = ${input.spaceId}
      AND type = 'turn' AND status IN ('sending', 'acknowledged') FOR UPDATE`;
  return turns.length ? run : null;
}

/** Creates a normal chat card while leaving the daemon run and attempt running. */
export async function createLiveDaemonAsk(
  prisma: PrismaClient,
  input: CreateLiveDaemonAskInput,
  realtime?: RealtimeFanout,
): Promise<{ messageId: string; seq: number } | null> {
  const block = MessageBlockSchema.safeParse(input.block);
  if (
    !block.success ||
    block.data.kind !== "ask" ||
    !input.requestId ||
    !input.connectionId ||
    input.expiresAt.getTime() <= Date.now() ||
    block.data.input === "secret" ||
    block.data.approvalEffectId ||
    block.data.status === "answered"
  )
    return null;
  const validatedBlock = block.data;
  if (
    input.kind === "permission" &&
    (validatedBlock.actions?.length !== 2 ||
      !["allow", "deny"].every((id) => validatedBlock.actions?.some((action) => action.id === id)))
  )
    return null;
  if (input.kind === "question" && block.data.actions?.length) return null;
  await contentEncryptionOf(prisma)?.ring.all(input.spaceId);
  const result = await prisma.$transaction(async (tx) => {
    const run = await activeRun(tx, input);
    if (!run) return null;
    const duplicate = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM daemon_live_asks WHERE "machineId" = ${input.machineId} AND "turnId" = ${input.turnId} AND "requestId" = ${input.requestId}`;
    if (duplicate.length) return null;
    let ask: AskBlock = validatedBlock;
    if (input.kind === "permission") {
      const effect = await tx.externalEffect.create({
        data: {
          spaceId: input.spaceId,
          runId: input.runId,
          kind: "daemon_permission",
          idempotencyKey: randomUUID(),
          status: "intended",
          request: {},
        },
      });
      ask = { ...ask, approvalEffectId: effect.id };
    }
    const blocks = [{ ...ask, status: "pending" as const }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "bot",
      blocks,
      botId: run.botId,
      runId: input.runId,
    });
    const id = randomUUID();
    await tx.$executeRaw`INSERT INTO daemon_live_asks (id, "spaceId", "threadId", "runId", "attemptId", "leaseFence", "machineId", "connectionId", "turnId", "requestId", "messageId", kind, "expiresAt") VALUES (${id}, ${input.spaceId}, ${input.threadId}, ${input.runId}, ${input.attemptId}, ${input.leaseFence}, ${input.machineId}, ${input.connectionId}, ${input.turnId}, ${input.requestId}, ${message.id}, ${input.kind}, ${input.expiresAt})`;
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      runId: input.runId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { messageId: message.id, seq: event.seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!result) return null;
  await notifyRealtime(realtime, input.threadId, result.seq);
  return { messageId: result.messageId, seq: result.seq };
}

export async function answerLiveDaemonAsk(
  prisma: PrismaClient,
  input: AnswerRunInput,
  realtime?: RealtimeFanout,
): Promise<boolean> {
  if (
    input.dismiss ||
    input.fields ||
    input.username !== undefined ||
    input.remember !== undefined ||
    input.answer.length > THREAD_MESSAGE_TEXT_MAX_LENGTH
  )
    return false;
  await contentEncryptionOf(prisma)?.ring.all(input.spaceId);
  const store = createDaemonMachineStore(prisma);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const rows = await tx.$queryRaw<
      Array<CreateLiveDaemonAskInput & { id: string; messageId: string; answeredAt: Date | null }>
    >`SELECT * FROM daemon_live_asks WHERE "messageId" = ${input.messageId} AND "spaceId" = ${input.spaceId} AND "threadId" = ${input.threadId} AND "runId" = ${input.runId} AND "answeredAt" IS NULL AND "expiresAt" > clock_timestamp() FOR UPDATE`;
    const ask = rows[0];
    if (!ask) return null;
    const run = await activeRun(tx, ask);
    if (!run || run.userId !== input.answeredByUserId) return null;
    const behavior = ask.kind === "permission" ? input.answer : input.answer.trim() ? "answer" : "";
    if (
      ask.kind === "permission"
        ? behavior !== "allow" && behavior !== "deny"
        : behavior !== "answer"
    )
      return null;
    const message = await tx.message.findFirst({
      where: { id: input.messageId, runId: input.runId, threadId: input.threadId, role: "bot" },
    });
    const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
    if (!message || !parsed.success || parsed.data.length !== 1) return null;
    const block = parsed.data[0];
    if (block?.kind !== "ask" || block.status === "answered") return null;
    if (ask.kind === "permission") {
      if (!block.approvalEffectId) return null;
      const effect = await tx.externalEffect.updateMany({
        where: {
          id: block.approvalEffectId,
          runId: input.runId,
          spaceId: input.spaceId,
          kind: "daemon_permission",
          status: "intended",
        },
        data: { status: behavior === "allow" ? "approved" : "denied" },
      });
      if (effect.count !== 1) return null;
    }
    const command = await store.enqueueInTransaction(tx, {
      machineId: ask.machineId,
      spaceId: ask.spaceId,
      threadId: ask.threadId,
      turnId: ask.turnId,
      type: "answer",
      expiresAt: ask.expiresAt,
      payload: {
        threadId: ask.threadId,
        turnId: ask.turnId,
        requestId: ask.requestId,
        behavior,
        ...(behavior === "answer" ? { message: input.answer } : {}),
      },
    });
    if (command.status !== "pending") throw new Error("Daemon connection is unavailable");
    await tx.$executeRaw`UPDATE daemon_live_asks SET "answeredAt" = clock_timestamp() WHERE id = ${ask.id}`;
    const blocks = [{ ...block, status: "answered" as const, answer: input.answer }];
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: run.botId,
      runId: input.runId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { seq: event.seq, botId: run.botId, kind: ask.kind, behavior };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (result === null) return false;
  if (result.kind === "permission") {
    await recordSecurityEvent({
      type: "approval.decided",
      userId: input.answeredByUserId,
      spaceId: input.spaceId,
      metadata: {
        decision: result.behavior,
        effectKind: "daemon_permission",
        runId: input.runId,
      },
    });
  }
  await notifyRealtime(realtime, input.threadId, result.seq);
  return true;
}

export async function expireLiveDaemonAsks(
  prisma: PrismaClient,
  input: { machineId: string; turnIds: string[] },
  realtime?: RealtimeFanout,
) {
  if (!input.turnIds.length) return;
  const notifications: Array<{ threadId: string; seq: number }> = [];
  await prisma.$transaction(async (tx) => {
    for (const turnId of input.turnIds) {
      const asks = await tx.$queryRaw<
        Array<{
          id: string;
          spaceId: string;
          threadId: string;
          runId: string;
          messageId: string;
          kind: string;
        }>
      >`SELECT id, "spaceId", "threadId", "runId", "messageId", kind FROM daemon_live_asks WHERE "machineId" = ${input.machineId} AND "turnId" = ${turnId} AND "answeredAt" IS NULL FOR UPDATE`;
      for (const ask of asks) {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${ask.threadId} FOR UPDATE`;
        const message = await tx.message.findFirst({
          where: { id: ask.messageId, runId: ask.runId, threadId: ask.threadId, role: "bot" },
        });
        const parsed = MessageBlockSchema.array().safeParse(message?.blocks);
        const block = parsed?.success ? parsed.data[0] : null;
        if (message && block?.kind === "ask" && block.status !== "answered") {
          if (ask.kind === "permission" && block.approvalEffectId) {
            await tx.externalEffect.updateMany({
              where: {
                id: block.approvalEffectId,
                runId: ask.runId,
                spaceId: ask.spaceId,
                kind: "daemon_permission",
                status: "intended",
              },
              data: { status: "denied" },
            });
          }
          const blocks = [
            {
              ...block,
              status: "answered" as const,
              answer: ask.kind === "permission" ? "deny" : "",
            },
          ];
          await tx.message.update({ where: { id: message.id }, data: { blocks } });
          const run = await tx.run.findFirst({
            where: { id: ask.runId },
            select: { botId: true },
          });
          if (run) {
            const event = await appendEventInTransaction(tx, {
              spaceId: ask.spaceId,
              threadId: ask.threadId,
              botId: run.botId,
              runId: ask.runId,
              type: "thread.message.updated",
              payload: { messageId: message.id, role: "bot", blocks },
            });
            notifications.push({ threadId: ask.threadId, seq: event.seq });
          }
        }
        await tx.$executeRaw`UPDATE daemon_live_asks SET "answeredAt" = clock_timestamp(), "expiresAt" = clock_timestamp() WHERE id = ${ask.id}`;
      }
    }
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  for (const item of notifications) await notifyRealtime(realtime, item.threadId, item.seq);
}

export async function expireOverdueLiveDaemonAsks(prisma: PrismaClient, realtime?: RealtimeFanout) {
  const rows = await prisma.$queryRaw<Array<{ machineId: string; turnId: string }>>`
    SELECT DISTINCT "machineId", "turnId" FROM daemon_live_asks
    WHERE "answeredAt" IS NULL AND "expiresAt" <= clock_timestamp()`;
  const turns = new Map<string, string[]>();
  for (const row of rows) {
    const list = turns.get(row.machineId) ?? [];
    list.push(row.turnId);
    turns.set(row.machineId, list);
  }
  for (const [machineId, turnIds] of turns) {
    await expireLiveDaemonAsks(prisma, { machineId, turnIds }, realtime);
  }
}
