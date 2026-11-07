-- A bot can name the paired machine it runs on. Null keeps the previous
-- behavior: the user's most recently connected machine. Additive only.

ALTER TABLE "bots" ADD COLUMN "userDeviceId" TEXT;

ALTER TABLE "bots" ADD CONSTRAINT "bots_userDeviceId_fkey"
  FOREIGN KEY ("userDeviceId") REFERENCES "user_devices"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
