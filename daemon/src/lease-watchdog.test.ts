import { describe, expect, it } from "bun:test";
import { leaseWatchdog } from "./lease-watchdog.ts";

describe("lease watchdog", () => {
  it("requires a heartbeat and expires when renewals stop", async () => {
    let expirations = 0;
    const watchdog = leaseWatchdog(50, () => expirations++);
    expect(watchdog.canReceive()).toBe(false);
    watchdog.receiveHeartbeat();
    expect(watchdog.canReceive()).toBe(true);
    await Bun.sleep(80);
    expect(expirations).toBe(1);
    watchdog.receiveHeartbeat();
    expect(watchdog.canReceive()).toBe(false);
    expect(expirations).toBe(1);
    watchdog.close();
  });

  it("extends the deadline after each timely heartbeat", async () => {
    let expired = false;
    const watchdog = leaseWatchdog(100, () => {
      expired = true;
    });
    watchdog.receiveHeartbeat();
    await Bun.sleep(60);
    watchdog.receiveHeartbeat();
    await Bun.sleep(60);
    expect(watchdog.canReceive()).toBe(true);
    expect(expired).toBe(false);
    watchdog.close();
  });

  it("does not accept a late heartbeat when the event loop was blocked", () => {
    let expired = false;
    const watchdog = leaseWatchdog(10, () => {
      expired = true;
    });
    Bun.sleepSync(25);
    watchdog.receiveHeartbeat();
    expect(expired).toBe(true);
    expect(watchdog.canReceive()).toBe(false);
    watchdog.close();
  });

  it("cancels its timer on close", async () => {
    let expired = false;
    const watchdog = leaseWatchdog(10, () => {
      expired = true;
    });
    watchdog.close();
    await Bun.sleep(25);
    expect(expired).toBe(false);
  });
});
