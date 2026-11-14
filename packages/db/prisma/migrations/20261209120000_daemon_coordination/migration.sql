CREATE TABLE "daemon_machines" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "revokedAt" TIMESTAMP(3),
  "connectionId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3)
);
CREATE INDEX "daemon_machines_userId_idx" ON "daemon_machines"("userId");

CREATE TABLE "daemon_assignments" (
  "botId" TEXT PRIMARY KEY REFERENCES "bots"("id") ON DELETE CASCADE,
  "machineId" TEXT NOT NULL REFERENCES "daemon_machines"("id") ON DELETE CASCADE,
  "cwd" TEXT NOT NULL,
  "agent" TEXT
);
CREATE INDEX "daemon_assignments_machineId_idx" ON "daemon_assignments"("machineId");

CREATE TABLE "daemon_commands" (
  "id" TEXT PRIMARY KEY,
  "machineId" TEXT NOT NULL REFERENCES "daemon_machines"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "connectionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "daemon_commands_machineId_status_createdAt_idx" ON "daemon_commands"("machineId", "status", "createdAt");
CREATE INDEX "daemon_commands_machineId_turnId_idx" ON "daemon_commands"("machineId", "turnId");

