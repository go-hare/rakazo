CREATE TABLE "daemon_live_asks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "leaseFence" INTEGER NOT NULL,
  "machineId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "answeredAt" TIMESTAMP(3),
  CONSTRAINT "daemon_live_asks_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE,
  CONSTRAINT "daemon_live_asks_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "daemon_live_asks_messageId_key" ON "daemon_live_asks"("messageId");
CREATE UNIQUE INDEX "daemon_live_asks_machineId_turnId_requestId_key" ON "daemon_live_asks"("machineId", "turnId", "requestId");
CREATE INDEX "daemon_live_asks_runId_idx" ON "daemon_live_asks"("runId");
