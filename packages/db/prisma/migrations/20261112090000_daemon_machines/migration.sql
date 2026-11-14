-- The daemon turn that owns a run, when it is not executed on the worker.
ALTER TABLE "runs" ADD COLUMN "deviceId" TEXT;
ALTER TABLE "runs" ADD COLUMN "deviceTurnId" TEXT;
