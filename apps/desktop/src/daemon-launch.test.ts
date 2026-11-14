import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopDaemon, daemonEntry, daemonStartArgs } from "./daemon-launch.js";
import { readDeviceConsent } from "./user-device.js";

vi.mock("./user-device.js", () => ({
  readDeviceConsent: vi.fn(),
}));

const consent = vi.mocked(readDeviceConsent);

afterEach(() => {
  vi.clearAllMocks();
});

function session(userId = "user", sessionId = "session") {
  return Response.json({ user: { id: userId }, session: { id: sessionId } });
}

function token(userId = "user", sessionId = "session") {
  return Response.json({ token: "a".repeat(64), userId, sessionId });
}

describe("desktop daemon launch", () => {
  it("points a packaged app at its platform executable and dev at the repo", () => {
    expect(
      daemonEntry({ appPath: "/app/apps/desktop", packaged: false, resourcesPath: "/r" }),
    ).toBe(path.resolve("/app/apps/desktop", "..", "..", "daemon", "src", "main.ts"));
    expect(
      daemonEntry({
        appPath: "/app",
        packaged: true,
        resourcesPath: "/r",
        platform: "win32",
        arch: "x64",
      }),
    ).toContain("rakazo-daemon-windows-x64.exe");
    expect(daemonStartArgs("rakazo-daemon-linux-x64")).toEqual([
      "start",
      "--foreground",
      "--config-stdin",
    ]);
  });

  it("does not start without a session or consent", async () => {
    const spawnProcess = vi.fn();
    const daemon = createDesktopDaemon({
      entry: "daemon",
      userDataDir: "/data",
      name: async () => "Laptop",
      spawnProcess,
    });
    await daemon.select("https://app.example", async () => new Response("no", { status: 401 }));
    expect(spawnProcess).not.toHaveBeenCalled();
    consent.mockResolvedValue({ consent: "declined", userId: "user" });
    await daemon.select("https://app.example", async () => session());
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("starts with a session-bound token on stdin and revokes on stop", async () => {
    consent.mockResolvedValue({ consent: "allowed", userId: "user" });
    const kill = vi.fn();
    const end = vi.fn();
    const spawned: string[][] = [];
    const revoked: string[] = [];
    const daemon = createDesktopDaemon({
      entry: "rakazo-daemon",
      userDataDir: "/data",
      name: async () => "Laptop",
      spawnProcess: (_command, args) => {
        spawned.push(args);
        return {
          kill,
          stdin: { end, on() {} },
          once() {},
        };
      },
    });
    await daemon.select("https://app.example", async (url, init) => {
      if (url.includes("/api/auth/get-session")) return session();
      if (init.method === "DELETE") {
        revoked.push(
          String(init.headers && "authorization" in init.headers ? init.headers.authorization : ""),
        );
        return new Response(null, { status: 200 });
      }
      expect(JSON.parse(String(init.body))).toEqual({ desktop: true, name: "Laptop" });
      return token();
    });
    expect(spawned).toEqual([["start", "--foreground", "--config-stdin"]]);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ server: "https://app.example", token: "a".repeat(64), name: "Laptop" }),
    );
    daemon.stop();
    expect(kill).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(revoked[0]).toMatch(/^Bearer a{64}$/);
  });

  it("ignores a pending login after stop", async () => {
    consent.mockResolvedValue({ consent: "allowed", userId: "user" });
    let resolveLogin!: (response: Response) => void;
    const login = new Promise<Response>((resolve) => {
      resolveLogin = resolve;
    });
    const spawnProcess = vi.fn();
    const daemon = createDesktopDaemon({
      entry: "daemon",
      userDataDir: "/data",
      name: async () => "Laptop",
      spawnProcess,
    });
    const first = daemon.select("https://app.example", async (url) => {
      if (url.includes("/api/auth/get-session")) return session();
      return login;
    });
    daemon.stop();
    resolveLogin(token());
    await first;
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("revokes a token issued after the session changed", async () => {
    consent.mockResolvedValue({ consent: "allowed", userId: "user" });
    const revoked: string[] = [];
    let calls = 0;
    const spawnProcess = vi.fn(() => ({
      kill() {},
      stdin: { end() {}, on() {} },
      once() {},
    }));
    const daemon = createDesktopDaemon({
      entry: "daemon",
      userDataDir: "/data",
      name: async () => "Laptop",
      spawnProcess,
    });
    await daemon.select("https://app.example", async (url, init) => {
      if (url.includes("/api/auth/get-session")) {
        calls += 1;
        return session("user", calls === 1 ? "first" : "second");
      }
      if (init.method === "DELETE") {
        revoked.push("revoked");
        return new Response(null, { status: 200 });
      }
      return token("user", "first");
    });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(revoked).toEqual(["revoked"]);
  });
});
