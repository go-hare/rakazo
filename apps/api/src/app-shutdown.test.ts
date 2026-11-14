import type { JobWorkerHost } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { beginJobDrain } from "./app.js";

describe("API job shutdown", () => {
  it("signals runs to hand off while waiting for background jobs to drain", async () => {
    const shutdown = new AbortController();
    let finishJob!: () => void;
    const job = new Promise<void>((resolve) => {
      finishJob = resolve;
    });
    const stop = vi.fn(async () => {
      expect(shutdown.signal.aborted).toBe(true);
      await job;
    });
    const host = { stop } as unknown as JobWorkerHost;
    let drained = false;
    const draining = beginJobDrain(shutdown, host).then(() => {
      drained = true;
    });
    expect(stop).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(drained).toBe(false);
    finishJob();
    await draining;
    expect(drained).toBe(true);
  });
});
