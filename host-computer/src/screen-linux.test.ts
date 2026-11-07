import { describe, expect, it } from "bun:test";
import { findWindow } from "./screen-linux.ts";
import { HostScreenError } from "./screen.ts";

describe("linux screen", () => {
  it("refuses to look when this computer has no display", async () => {
    const display = process.env.DISPLAY;
    delete process.env.DISPLAY;
    try {
      await expect(findWindow("Firefox")).rejects.toThrow(HostScreenError);
    } finally {
      if (display !== undefined) process.env.DISPLAY = display;
    }
  });
});
