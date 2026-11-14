import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { LocalKeyProvider, masterKeysFromEnv } from "./content-keys.js";
import { createDaemonMachineStore } from "./daemon-machine-store.js";
import { asSystem } from "./row-security.js";

const url = process.env.DATABASE_URL;
const suite = process.env.VERIFY_DATABASE && url ? describe.sequential : describe.skip;

suite("daemon coordination (PostgreSQL)", () => {
  const suffix = randomUUID();
  const userId = `daemon-user-${suffix}`;
  const spaceId = `daemon-space-${suffix}`;
  const orgId = `daemon-org-${suffix}`;
  let db: ReturnType<typeof createDb>;
  let store: ReturnType<typeof createDaemonMachineStore>;
  let machineId: string;
  let seeded = 0;

  async function runningTurn(turnId: string, ownerMachineId = machineId) {
    const prisma = asSystem(db.prisma);
    seeded += 1;
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: `Turn ${seeded}`, color: "ink" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId, userId, botId: bot.id },
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "test",
        status: "running",
      },
    });
    await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker",
        leaseFence: 1,
        deviceId: ownerMachineId,
        deviceTurnId: turnId,
      },
    });
    return { threadId: thread.id };
  }

  beforeAll(async () => {
    db = createDb(url!, {
      keyProvider: new LocalKeyProvider([
        { id: `test-${suffix}`, key: randomBytes(32) },
        ...masterKeysFromEnv(),
      ]),
      encryptContent: false,
    });
    const prisma = asSystem(db.prisma);
    store = createDaemonMachineStore(prisma);
    await prisma.user.create({
      data: { id: userId, name: "Test", email: `${suffix}@example.test` },
    });
    await prisma.organization.create({
      data: { id: orgId, name: "Test", slug: orgId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId: orgId, name: "Test" } });
    const machine = await store.issue(userId, "Test");
    machineId = machine.id;
    expect(await store.authenticate(machine.token)).toMatchObject({ id: machineId, userId });
    const row = await db.pool.query('SELECT "tokenHash" FROM daemon_machines WHERE id = $1', [
      machineId,
    ]);
    expect(row.rows[0].tokenHash).not.toContain(machine.token);
  });

  afterAll(async () => {
    if (!db) return;
    const prisma = asSystem(db.prisma);
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("binds desktop machines to a live session and revokes by token after logout", async () => {
    const prisma = asSystem(db.prisma);
    const sessionId = `daemon-session-${suffix}`;
    await prisma.session.create({
      data: {
        id: sessionId,
        userId,
        token: `session-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(store.issue(userId, "Missing", "missing")).rejects.toThrow(
      "Invalid daemon session",
    );
    await expect(store.issue("other-user", "Wrong owner", sessionId)).rejects.toThrow(
      "Invalid daemon session",
    );
    const machine = await store.issue(userId, "Desktop", sessionId);
    expect(await store.authenticate(machine.token)).toMatchObject({ id: machine.id });
    expect(await store.acquireConnection(machine.id, "desktop", 60_000)).toEqual([]);
    const sessionTurn = await runningTurn("session-turn", machine.id);
    const command = await store.enqueue({
      machineId: machine.id,
      spaceId,
      threadId: sessionTurn.threadId,
      turnId: "session-turn",
      type: "turn",
      payload: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await store.claimNext(machine.id, "desktop")).not.toBeNull();
    await prisma.session.update({ where: { id: sessionId }, data: { expiresAt: new Date(0) } });
    expect(await store.authenticate(machine.token)).toBeNull();
    expect(await store.acquireConnection(machine.id, "other", 60_000)).toBeNull();
    expect(await store.renewConnection(machine.id, "desktop", 60_000)).toBe(false);
    expect(await store.claimNext(machine.id, "desktop")).toBeNull();
    expect(await store.ack(machine.id, "desktop", command)).toBe(false);
    expect(await store.reject(machine.id, "desktop", command)).toBe(false);
    expect(await store.finishTurn(machine.id, "desktop", "session-turn")).toBe(false);
    await expect(store.issue(userId, "Expired", sessionId)).rejects.toThrow(
      "Invalid daemon session",
    );
    await prisma.session.delete({ where: { id: sessionId } });
    expect(await store.authenticate(machine.token)).toBeNull();
    expect(await store.revokeToken(machine.token)).toBe(true);
    expect(await store.revokeToken(machine.token)).toBe(false);
    expect(await store.failedTurns(machine.id)).toContain("session-turn");
    expect(await store.authenticate((await store.issue(userId, "CLI")).token)).not.toBeNull();
  });

  it("revokes authentication and leases without losing bindings or pending recovery", async () => {
    const machine = await store.issue(userId, "Revoked");
    const botId = `daemon-bot-${suffix}`;
    const prisma = asSystem(db.prisma);
    await prisma.bot.create({ data: { id: botId, spaceId, userId, name: "Test", color: "ink" } });
    await prisma.daemonAssignment.create({ data: { botId, machineId: machine.id, cwd: "/test" } });
    expect(await store.acquireConnection(machine.id, "revoked-connection", 60000)).toEqual([]);
    const enqueue = async (turnId: string) => {
      const turn = await runningTurn(turnId, machine.id);
      return store.enqueue({
        machineId: machine.id,
        spaceId,
        threadId: turn.threadId,
        turnId,
        type: "turn",
        payload: { text: turnId },
        expiresAt: new Date(Date.now() + 60000),
      });
    };
    const acknowledged = await enqueue("acknowledged");
    await store.claimNext(machine.id, "revoked-connection");
    expect(await store.ack(machine.id, "revoked-connection", acknowledged)).toBe(true);
    await enqueue("sending");
    await store.claimNext(machine.id, "revoked-connection");
    await enqueue("pending");
    expect(await store.revoke("another-user", machine.id)).toBe(false);
    expect(await store.authenticate(machine.token)).not.toBeNull();
    expect(await store.revoke(userId, machine.id)).toBe(true);
    expect(await store.revoke(userId, machine.id)).toBe(false);
    expect(await store.authenticate(machine.token)).toBeNull();
    expect(await store.renewConnection(machine.id, "revoked-connection", 60000)).toBe(false);
    expect(await store.acquireConnection(machine.id, "new-connection", 60000)).toBeNull();
    expect(await store.claimNext(machine.id, "revoked-connection")).toBeNull();
    expect(await store.pinned(botId)).toMatchObject({ machineId: machine.id });
    expect(new Set(await store.failedTurns(machine.id))).toEqual(
      new Set(["acknowledged", "sending", "pending"]),
    );
    await enqueue("after-revocation");
    expect(await store.failedTurns(machine.id)).toContain("after-revocation");
    const racing = await store.issue(userId, "Race");
    await Promise.all([
      store.revoke(userId, racing.id),
      store.enqueue({
        machineId: racing.id,
        spaceId,
        threadId: "thread",
        turnId: "racing",
        type: "turn",
        payload: {},
        expiresAt: new Date(Date.now() + 60000),
      }),
    ]);
    expect(await store.failedTurns(racing.id)).toEqual(["racing"]);
    expect(await store.list(userId)).not.toContainEqual(
      expect.objectContaining({ id: machine.id }),
    );
  });

  it("claims only due runs in Spaces accepting work", async () => {
    const prisma = asSystem(db.prisma);
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Claims", color: "ink" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "test",
        status: "queued",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "queued",
        trigger: "user",
        wakeAt: new Date(Date.now() + 3600_000),
      },
    });
    expect(await store.claimUnavailableRun(run.id, 0)).toBeNull();
    expect(await prisma.attempt.count({ where: { runId: run.id } })).toBe(0);
    await prisma.run.update({ where: { id: run.id }, data: { wakeAt: new Date(0) } });
    await prisma.space.update({ where: { id: spaceId }, data: { deletingAt: new Date() } });
    try {
      expect(await store.claimUnavailableRun(run.id, 0)).toBeNull();
      expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "queued",
        leaseFence: 0,
      });
      expect(await prisma.attempt.count({ where: { runId: run.id } })).toBe(0);
    } finally {
      await prisma.space.update({ where: { id: spaceId }, data: { deletingAt: null } });
    }
    expect(await store.claimUnavailableRun(run.id, 1)).toBeNull();
    const claims = await Promise.all([
      store.claimUnavailableRun(run.id, 0),
      store.claimUnavailableRun(run.id, 0),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await prisma.attempt.count({ where: { runId: run.id } })).toBe(1);
  });

  it("rolls back commands inserted with the caller's transaction", async () => {
    const prisma = asSystem(db.prisma);
    let commandId = "";
    await expect(
      prisma.$transaction(async (tx) => {
        expect(await store.lockMachine(tx, machineId)).not.toBeNull();
        const command = await store.enqueueInTransaction(tx, {
          machineId,
          spaceId,
          threadId: "thread",
          turnId: "rollback",
          type: "answer",
          payload: { behavior: "deny" },
          expiresAt: new Date(Date.now() + 60000),
        });
        commandId = command.id;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await prisma.daemonCommand.findUnique({ where: { id: commandId } })).toBeNull();
  });

  it("encrypts payload even when content encryption is off and fences competing connections", async () => {
    const [first, second] = await Promise.all([
      store.acquireConnection(machineId, "one", 60000),
      store.acquireConnection(machineId, "two", 60000),
    ]);
    expect([first, second].filter((value) => value !== null)).toHaveLength(1);
    const owner = first === null ? "two" : "one";
    const other = owner === "one" ? "two" : "one";
    const live = await runningTurn("turn");
    const id = await store.enqueue({
      machineId,
      spaceId,
      threadId: live.threadId,
      turnId: "turn",
      type: "turn",
      payload: { text: "sensitive-test-value" },
      expiresAt: new Date(Date.now() + 60000),
    });
    const stored = await db.pool.query(
      "SELECT payload::text AS payload FROM daemon_commands WHERE id = $1",
      [id],
    );
    expect(stored.rows[0].payload).not.toContain("sensitive-test-value");
    expect(await store.claimNext(machineId, other)).toBeNull();
    const command = await store.claimNext(machineId, owner);
    expect(command).toMatchObject({ id, payload: { text: "sensitive-test-value" } });
    expect(await store.ack(machineId, other, id)).toBe(false);
    expect(await store.ack(machineId, owner, id)).toBe(true);
    expect(await store.releaseConnection(machineId, other)).toEqual([]);
    expect(await store.releaseConnection(machineId, owner, true)).toEqual([]);
    expect(await store.releaseConnection(machineId, owner)).toEqual(["turn"]);
    expect(await store.failedTurns(machineId)).toEqual(["turn"]);
    expect(await store.acquireConnection(machineId, other, 60000)).toEqual([]);
    expect(await store.claimNext(machineId, other)).toBeNull();
    await store.settleFailedTurn(machineId, "turn");
    expect(await store.failedTurns(machineId)).toEqual([]);
  });
});
