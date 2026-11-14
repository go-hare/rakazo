import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { encryptText, sealJson } from "./content-crypto.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { spaceTakesWork } from "./spaces.js";

export type DaemonCommandType = "turn" | "answer" | "cancel";
export interface DaemonCommandInput {
  machineId: string;
  spaceId: string;
  threadId: string;
  turnId: string;
  type: DaemonCommandType;
  payload: Prisma.InputJsonValue;
  expiresAt: Date;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const validSession = Prisma.sql`(m."sessionId" IS NULL OR EXISTS (SELECT 1 FROM "session" s WHERE s.id = m."sessionId" AND s."userId" = m."userId" AND s."expiresAt" > clock_timestamp()))`;

/** Connection lease (30s) plus the daemon heartbeat watchdog (20s). */
export const DAEMON_BARRIER_MS = 50_000;

export interface SubmitDaemonTurnInput {
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  botId: string;
  spaceId: string;
  threadId: string;
  userId: string;
  machineId: string;
  turnId: string;
  payload: Prisma.InputJsonValue;
}

/** Durable coordination only. Socket ownership and failure recovery belong to the caller. */
export function createDaemonMachineStore(prisma: PrismaClient) {
  function requireEncryption() {
    const encryption = contentEncryptionOf(prisma);
    if (!encryption) throw new Error("Daemon commands require content encryption");
    return encryption;
  }

  async function lockMachine(tx: Prisma.TransactionClient, machineId: string) {
    const rows = await tx.$queryRaw<
      Array<{ revokedAt: Date | null }>
    >`SELECT "revokedAt" FROM daemon_machines WHERE id = ${machineId} FOR UPDATE`;
    return rows[0] ?? null;
  }

  async function enqueueInTransaction(tx: Prisma.TransactionClient, input: DaemonCommandInput) {
    const machine = await lockMachine(tx, input.machineId);
    if (!machine) throw new Error("Daemon machine does not exist");
    const id = randomUUID();
    const key = await requireEncryption().ring.current(input.spaceId);
    const payload = sealJson(input.payload, new Set(), (text) =>
      encryptText(
        key,
        { table: "daemon_commands", column: "payload", rowId: id, owner: input.threadId },
        text,
      ),
    );
    const status = machine.revokedAt ? "uncertain" : "pending";
    await tx.$executeRaw`INSERT INTO daemon_commands (id, "machineId", "spaceId", "threadId", "turnId", type, payload, status, "expiresAt") VALUES (${id}, ${input.machineId}, ${input.spaceId}, ${input.threadId}, ${input.turnId}, ${input.type}, ${JSON.stringify(payload)}::jsonb, ${status}, ${input.expiresAt})`;
    return { id, status };
  }

  async function extendBotBarrier(tx: Prisma.TransactionClient, botId: string) {
    await tx.$executeRaw`UPDATE bots SET "daemonUncertainUntil" = clock_timestamp() + ${DAEMON_BARRIER_MS} * interval '1 millisecond' WHERE id = ${botId}`;
  }

  async function extendMachineBarriers(tx: Prisma.TransactionClient, machineId: string) {
    await tx.$executeRaw`
      UPDATE bots SET "daemonUncertainUntil" = clock_timestamp() + ${DAEMON_BARRIER_MS} * interval '1 millisecond'
      WHERE id IN (
        SELECT r."botId" FROM runs r
        JOIN daemon_commands c ON c."machineId" = r."deviceId" AND c."turnId" = r."deviceTurnId"
        WHERE r."deviceId" = ${machineId} AND c.type = 'turn' AND c.status IN ('sending', 'acknowledged')
      )`;
  }

  async function clearBarrierIfIdle(
    tx: Prisma.TransactionClient,
    machineId: string,
    turnId: string,
  ) {
    await tx.$executeRaw`
      UPDATE bots SET "daemonUncertainUntil" = NULL
      WHERE id = (SELECT r."botId" FROM runs r WHERE r."deviceId" = ${machineId} AND r."deviceTurnId" = ${turnId})
        AND NOT EXISTS (
          SELECT 1 FROM daemon_commands c
          JOIN runs r2 ON r2."deviceId" = c."machineId" AND r2."deviceTurnId" = c."turnId"
          WHERE r2."botId" = bots.id AND c.type = 'turn' AND c.status IN ('sending', 'acknowledged')
        )`;
  }

  async function updateCommand(
    machineId: string,
    connectionId: string,
    id: string,
    status: "acknowledged" | "rejected" | "finished",
  ) {
    const commandFilter =
      status === "finished"
        ? Prisma.sql`c."turnId" = ${id} AND c.type = 'turn' AND c.status IN ('sending', 'acknowledged')`
        : Prisma.sql`c.id = ${id} AND c.status = 'sending'`;
    const count = await prisma.$executeRaw`
      UPDATE daemon_commands c SET status = ${status} FROM daemon_machines m
      WHERE c."machineId" = ${machineId} AND c."connectionId" = ${connectionId}
        AND ${commandFilter} AND m.id = c."machineId" AND m."revokedAt" IS NULL
        AND m."connectionId" = ${connectionId} AND m."leaseExpiresAt" > clock_timestamp()
        AND ${validSession}`;
    return count === 1;
  }

  return {
    lockMachine,
    enqueueInTransaction,
    async issue(userId: string, name: string, sessionId?: string) {
      const token = randomBytes(32).toString("hex");
      const id = randomUUID();
      if (sessionId !== undefined) {
        const rows = await prisma.$queryRaw<Array<{ id: string }>>`
          INSERT INTO daemon_machines (id, "userId", name, "tokenHash", "sessionId")
          SELECT ${id}, ${userId}, ${name}, ${hashToken(token)}, s.id FROM "session" s
          WHERE s.id = ${sessionId} AND s."userId" = ${userId} AND s."expiresAt" > clock_timestamp()
          RETURNING id`;
        if (!rows.length) throw new Error("Invalid daemon session");
      } else {
        await prisma.daemonMachine.create({
          data: { id, userId, name, tokenHash: hashToken(token) },
        });
      }
      return { id, userId, name, token };
    },
    async authenticate(token: string) {
      if (!token) return null;
      const rows = await prisma.$queryRaw<Array<{ id: string; userId: string; name: string }>>`
        SELECT m.id, m."userId", m.name FROM daemon_machines m
        WHERE m."tokenHash" = ${hashToken(token)} AND m."revokedAt" IS NULL AND ${validSession}`;
      return rows[0] ?? null;
    },
    async list(userId: string) {
      return prisma.daemonMachine.findMany({
        where: { userId, revokedAt: null },
        select: { id: true, name: true, leaseExpiresAt: true },
      });
    },
    async revoke(userId: string, machineId: string) {
      return prisma.$transaction(async (tx) => {
        const machines = await tx.$queryRaw<
          Array<{ id: string }>
        >`UPDATE daemon_machines SET "revokedAt" = clock_timestamp(), "connectionId" = NULL, "leaseExpiresAt" = NULL WHERE id = ${machineId} AND "userId" = ${userId} AND "revokedAt" IS NULL RETURNING id`;
        if (!machines.length) return false;
        await tx.daemonCommand.updateMany({
          where: { machineId, status: { in: ["pending", "sending", "acknowledged"] } },
          data: { status: "uncertain" },
        });
        return true;
      });
    },
    async revokeToken(token: string) {
      if (!token) return false;
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE daemon_machines SET "revokedAt" = clock_timestamp(), "connectionId" = NULL, "leaseExpiresAt" = NULL
          WHERE "tokenHash" = ${hashToken(token)} AND "revokedAt" IS NULL RETURNING id`;
        const machine = rows[0];
        if (!machine) return false;
        await tx.daemonCommand.updateMany({
          where: { machineId: machine.id, status: { in: ["pending", "sending", "acknowledged"] } },
          data: { status: "uncertain" },
        });
        return true;
      });
    },
    async pin(userId: string, botId: string, machineId: string, cwd: string, agent?: string) {
      if (!cwd) return false;
      return prisma.$transaction(async (tx) => {
        const machine = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM daemon_machines WHERE id = ${machineId} AND "userId" = ${userId} AND "revokedAt" IS NULL FOR UPDATE`;
        const bot = await tx.bot.findFirst({
          where: { id: botId, space: { memberships: { some: { userId } } } },
          select: { id: true },
        });
        if (!machine.length || !bot) return false;
        await tx.daemonAssignment.upsert({
          where: { botId },
          create: { botId, machineId, cwd, agent },
          update: { machineId, cwd, agent: agent ?? null },
        });
        return true;
      });
    },
    async unpin(userId: string, botId: string) {
      const result = await prisma.daemonAssignment.deleteMany({
        where: { botId, bot: { space: { memberships: { some: { userId } } } } },
      });
      return result.count === 1;
    },
    async pinned(botId: string) {
      return prisma.daemonAssignment.findUnique({
        where: { botId },
        select: { machineId: true, cwd: true, agent: true },
      });
    },
    async assignments(userId: string) {
      return prisma.daemonAssignment.findMany({
        where: { machine: { userId }, bot: { space: { memberships: { some: { userId } } } } },
        select: { botId: true, machineId: true, cwd: true, agent: true },
      });
    },
    async acquireConnection(machineId: string, connectionId: string, leaseMs: number) {
      if (!connectionId || !Number.isSafeInteger(leaseMs) || leaseMs <= 0)
        throw new Error("Invalid daemon connection lease");
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ connectionId: string | null }>
        >`SELECT m."connectionId" FROM daemon_machines m WHERE m.id = ${machineId} AND m."revokedAt" IS NULL AND ${validSession} AND (m."connectionId" IS NULL OR m."leaseExpiresAt" <= clock_timestamp()) FOR UPDATE`;
        if (!rows.length) return null;
        const previous = rows[0]?.connectionId;
        const turns = previous
          ? await tx.daemonCommand.findMany({
              where: {
                machineId,
                connectionId: previous,
                type: "turn",
                status: { in: ["sending", "acknowledged"] },
              },
              select: { turnId: true },
            })
          : [];
        if (previous)
          await tx.daemonCommand.updateMany({
            where: {
              machineId,
              connectionId: previous,
              status: { in: ["sending", "acknowledged"] },
            },
            data: { status: "uncertain" },
          });
        await tx.$executeRaw`UPDATE daemon_machines SET "connectionId" = ${connectionId}, "leaseExpiresAt" = clock_timestamp() + ${leaseMs} * interval '1 millisecond' WHERE id = ${machineId}`;
        return turns.map((turn) => turn.turnId);
      });
    },
    async renewConnection(machineId: string, connectionId: string, leaseMs: number) {
      if (!connectionId || !Number.isSafeInteger(leaseMs) || leaseMs <= 0)
        throw new Error("Invalid daemon connection lease");
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ id: string }>
        >`UPDATE daemon_machines m SET "leaseExpiresAt" = clock_timestamp() + ${leaseMs} * interval '1 millisecond' WHERE m.id = ${machineId} AND m."revokedAt" IS NULL AND m."connectionId" = ${connectionId} AND m."leaseExpiresAt" > clock_timestamp() AND ${validSession} RETURNING m.id`;
        if (rows.length !== 1) return false;
        await extendMachineBarriers(tx, machineId);
        return true;
      });
    },
    async releaseConnection(machineId: string, connectionId: string, expiredOnly = false) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ id: string }>
        >`UPDATE daemon_machines SET "connectionId" = NULL, "leaseExpiresAt" = NULL WHERE id = ${machineId} AND "connectionId" = ${connectionId} AND (NOT ${expiredOnly} OR "leaseExpiresAt" <= clock_timestamp()) RETURNING id`;
        if (!rows.length) return [];
        const turns = await tx.daemonCommand.findMany({
          where: {
            machineId,
            connectionId,
            type: "turn",
            status: { in: ["sending", "acknowledged"] },
          },
          select: { turnId: true },
        });
        await tx.daemonCommand.updateMany({
          where: { machineId, connectionId, status: { in: ["sending", "acknowledged"] } },
          data: { status: "uncertain" },
        });
        return turns.map((turn) => turn.turnId);
      });
    },
    async expiredConnections() {
      return prisma.$queryRaw<
        Array<{ id: string; connectionId: string }>
      >`SELECT id, "connectionId" FROM daemon_machines WHERE "connectionId" IS NOT NULL AND "leaseExpiresAt" <= clock_timestamp()`;
    },
    async machinesWithFailedTurns() {
      return prisma.$queryRaw<
        Array<{ machineId: string }>
      >`SELECT DISTINCT "machineId" FROM daemon_commands WHERE status IN ('uncertain', 'rejected') OR (status = 'pending' AND "expiresAt" <= clock_timestamp())`;
    },
    async failedTurns(machineId: string) {
      const turns = await prisma.$queryRaw<
        Array<{ turnId: string }>
      >`SELECT DISTINCT "turnId" FROM daemon_commands WHERE "machineId" = ${machineId} AND (status IN ('uncertain', 'rejected') OR (status = 'pending' AND "expiresAt" <= clock_timestamp()))`;
      return turns.map((turn) => turn.turnId);
    },
    async settleFailedTurn(machineId: string, turnId: string) {
      await prisma.daemonCommand.updateMany({
        where: {
          machineId,
          turnId,
          OR: [
            { status: { in: ["uncertain", "rejected"] } },
            { status: "pending", expiresAt: { lte: new Date() } },
          ],
        },
        data: { status: "failed" },
      });
    },
    async claimRunAndEnqueue(
      input: DaemonCommandInput & { runId: string; leaseFence: number; leaseExpiresAt: Date },
    ) {
      if (input.type !== "turn") throw new Error("Run claim requires a turn command");
      return null;
    },
    async submitTurn(input: SubmitDaemonTurnInput) {
      return prisma.$transaction(async (tx) => {
        if (!(await spaceTakesWork(tx, input.spaceId))) return null;
        const bots = await tx.$queryRaw<
          Array<{ daemonUncertainUntil: Date | null }>
        >`SELECT "daemonUncertainUntil" FROM bots WHERE id = ${input.botId} FOR UPDATE`;
        const bot = bots[0];
        if (!bot) return null;
        if (bot.daemonUncertainUntil && bot.daemonUncertainUntil.getTime() > Date.now())
          return null;
        const busy = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM runs
          WHERE "botId" = ${input.botId} AND status = 'running' AND "deviceTurnId" IS NOT NULL
          FOR UPDATE`;
        if (busy.length) return null;
        const members = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT sm.id FROM space_members sm JOIN "user" u ON u.id = sm."userId"
          WHERE sm."spaceId" = ${input.spaceId} AND sm."userId" = ${input.userId}
            AND u."deactivatedAt" IS NULL FOR SHARE OF sm, u`;
        if (!members.length) return null;
        const machine = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT m.id FROM daemon_machines m
          WHERE m.id = ${input.machineId} AND m."userId" = ${input.userId} AND m."revokedAt" IS NULL
            AND ${validSession} FOR UPDATE`;
        if (!machine.length) return null;
        const pin = await tx.daemonAssignment.findFirst({
          where: { botId: input.botId, machineId: input.machineId },
          select: { botId: true },
        });
        if (!pin) return null;
        const attempt = await tx.attempt.findFirst({
          where: {
            id: input.attemptId,
            runId: input.runId,
            fence: input.leaseFence,
            status: "running",
          },
          select: { id: true },
        });
        if (!attempt) return null;
        const claimed = await tx.run.updateMany({
          where: {
            id: input.runId,
            botId: input.botId,
            spaceId: input.spaceId,
            threadId: input.threadId,
            userId: input.userId,
            status: "running",
            leaseOwner: input.leaseOwner,
            leaseFence: input.leaseFence,
            deviceTurnId: null,
          },
          data: { deviceId: input.machineId, deviceTurnId: input.turnId },
        });
        if (!claimed.count) return null;
        const command = await enqueueInTransaction(tx, {
          machineId: input.machineId,
          spaceId: input.spaceId,
          threadId: input.threadId,
          turnId: input.turnId,
          type: "turn",
          payload: input.payload,
          expiresAt: new Date(Date.now() + DAEMON_BARRIER_MS),
        });
        if (command.status !== "pending") throw new Error("Daemon connection is unavailable");
        await extendBotBarrier(tx, input.botId);
        return { turnId: input.turnId, commandId: command.id };
      });
    },
    async claimUnavailableRun(runId: string, fence: number) {
      return prisma.$transaction(async (tx) => {
        const run = await tx.run.findUnique({ where: { id: runId }, select: { spaceId: true } });
        if (!run || !(await spaceTakesWork(tx, run.spaceId))) return null;
        const claimed = await tx.run.updateMany({
          where: {
            id: runId,
            spaceId: run.spaceId,
            status: "queued",
            leaseFence: fence,
            OR: [{ wakeAt: null }, { wakeAt: { lte: new Date() } }],
          },
          data: {
            status: "running",
            leaseOwner: "daemon-unavailable",
            leaseFence: fence + 1,
            leaseExpiresAt: new Date(Date.now() + 30_000),
          },
        });
        if (!claimed.count) return null;
        const attempt = await tx.attempt.create({
          data: { runId, fence: fence + 1, status: "running" },
        });
        return { attemptId: attempt.id, fence: fence + 1 };
      });
    },
    async enqueue(input: DaemonCommandInput) {
      const command = await prisma.$transaction((tx) => enqueueInTransaction(tx, input));
      return command.id;
    },
    async claimNext(machineId: string, connectionId: string) {
      const encryption = requireEncryption();
      const rows = await prisma.$transaction(async (tx) => {
        const lease = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT m.id FROM daemon_machines m WHERE m.id = ${machineId} AND m."revokedAt" IS NULL AND m."connectionId" = ${connectionId} AND m."leaseExpiresAt" > clock_timestamp() AND ${validSession} FOR UPDATE`;
        if (!lease.length) return [];
        const claimed = await tx.$queryRaw<
          Array<{
            id: string;
            machineId: string;
            spaceId: string;
            threadId: string;
            turnId: string;
            type: DaemonCommandType;
            payload: unknown;
          }>
        >`
        UPDATE daemon_commands SET status = 'sending', "connectionId" = ${connectionId}
        WHERE id = (SELECT c.id FROM daemon_commands c JOIN daemon_machines m ON m.id = c."machineId" WHERE c."machineId" = ${machineId} AND m."connectionId" = ${connectionId} AND m."leaseExpiresAt" > clock_timestamp() AND c.status = 'pending' AND c."expiresAt" > clock_timestamp() ORDER BY c."createdAt", c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1)
        RETURNING id, "machineId", "spaceId", "threadId", "turnId", type, payload`;
        const command = claimed[0];
        if (!command) return [];
        if (command.type === "turn") {
          const runs = await tx.$queryRaw<Array<{ botId: string }>>`
            SELECT r."botId" FROM runs r
            WHERE r."deviceId" = ${machineId} AND r."deviceTurnId" = ${command.turnId}
              AND r."threadId" = ${command.threadId} AND r."spaceId" = ${command.spaceId}
              AND r.status = 'running'
            FOR UPDATE OF r`;
          if (!runs[0]) {
            await tx.daemonCommand.updateMany({
              where: { id: command.id, status: "sending" },
              data: { status: "rejected" },
            });
            return [];
          }
          await extendBotBarrier(tx, runs[0].botId);
        }
        if (command.type === "answer") {
          const opened = await encryption.openRows("DaemonCommand", claimed);
          const payload = opened[0]?.payload;
          const requestId =
            payload && typeof payload === "object" && !Array.isArray(payload)
              ? Reflect.get(payload, "requestId")
              : null;
          if (typeof requestId !== "string" || !requestId) {
            await tx.daemonCommand.updateMany({
              where: { id: command.id, status: "sending" },
              data: { status: "rejected" },
            });
            return [];
          }
          const asks = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT a.id FROM daemon_live_asks a
            JOIN runs r ON r.id = a."runId"
            WHERE a."machineId" = ${machineId} AND a."turnId" = ${command.turnId}
              AND a."requestId" = ${requestId} AND a."connectionId" = ${connectionId}
              AND a."answeredAt" IS NOT NULL AND a."expiresAt" > clock_timestamp()
              AND r.status = 'running' AND r."deviceId" = ${machineId}
              AND r."deviceTurnId" = ${command.turnId}
            FOR UPDATE OF a, r`;
          if (!asks.length) {
            await tx.daemonCommand.updateMany({
              where: { id: command.id, status: "sending" },
              data: { status: "rejected" },
            });
            return [];
          }
          return opened;
        }
        return claimed;
      });
      if (!rows.length) return null;
      if (rows[0]?.type === "answer") return rows[0];
      return (await encryption.openRows("DaemonCommand", rows))[0] ?? null;
    },
    async ack(machineId: string, connectionId: string, commandId: string) {
      return updateCommand(machineId, connectionId, commandId, "acknowledged");
    },
    async reject(machineId: string, connectionId: string, commandId: string) {
      return updateCommand(machineId, connectionId, commandId, "rejected");
    },
    async finishTurn(machineId: string, connectionId: string, turnId: string) {
      return prisma.$transaction(async (tx) => {
        const count = await tx.$executeRaw`
          UPDATE daemon_commands c SET status = 'finished' FROM daemon_machines m
          WHERE c."machineId" = ${machineId} AND c."connectionId" = ${connectionId}
            AND c."turnId" = ${turnId} AND c.type = 'turn' AND c.status IN ('sending', 'acknowledged')
            AND m.id = c."machineId" AND m."revokedAt" IS NULL
            AND m."connectionId" = ${connectionId} AND m."leaseExpiresAt" > clock_timestamp()
            AND ${validSession}`;
        if (count !== 1) return false;
        await clearBarrierIfIdle(tx, machineId, turnId);
        return true;
      });
    },
  };
}
