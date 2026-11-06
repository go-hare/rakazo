-- A bot can name the paired machine it runs on. Null keeps the previous
-- behavior: the user's most recently connected machine. Additive only.

ALTER TABLE "Bot" ADD COLUMN "userDeviceId" TEXT;

ALTER TABLE "Bot" ADD CONSTRAINT "Bot_userDeviceId_fkey"
  FOREIGN KEY ("userDeviceId") REFERENCES "user_devices"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
