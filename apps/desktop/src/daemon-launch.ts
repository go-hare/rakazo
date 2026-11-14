import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { secureHttpOrigin } from "@rakazo/contracts/network-host";
import { readDeviceConsent } from "./user-device.js";

export interface DaemonConfig {
  server: string;
  token: string;
  name: string;
}

export function daemonEntry(input: {
  appPath: string;
  packaged: boolean;
  resourcesPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): string {
  if (input.packaged) {
    const platform = input.platform ?? process.platform;
    const target = `${platform === "win32" ? "windows" : platform}-${input.arch ?? process.arch}`;
    return path.join(
      input.resourcesPath,
      "daemon",
      `rakazo-daemon-${target}${platform === "win32" ? ".exe" : ""}`,
    );
  }
  return path.resolve(input.appPath, "..", "..", "daemon", "src", "main.ts");
}

export function daemonStartArgs(entry: string): string[] {
  return entry.endsWith(".ts")
    ? [entry, "start", "--foreground", "--config-stdin"]
    : ["start", "--foreground", "--config-stdin"];
}

export interface DaemonProcess {
  kill(): unknown;
  stdin: { end(value: string): unknown; on(event: "error", listener: () => void): unknown } | null;
  once(event: "error" | "exit", listener: () => void): unknown;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Session = { userId: string; sessionId: string };

async function currentSession(origin: string, fetch: Fetch): Promise<Session | null> {
  const response = await fetch(new URL("/api/auth/get-session", origin).href, {
    credentials: "include",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("user" in body) || !("session" in body)) return null;
  const { user, session } = body;
  if (
    !user ||
    typeof user !== "object" ||
    !("id" in user) ||
    typeof user.id !== "string" ||
    !user.id
  )
    return null;
  if (
    !session ||
    typeof session !== "object" ||
    !("id" in session) ||
    typeof session.id !== "string" ||
    !session.id
  )
    return null;
  return { userId: user.id, sessionId: session.id };
}

/** Each launch has its own session-bound token, passed only through the child's stdin. */
export function createDesktopDaemon(input: {
  entry: string;
  userDataDir: string;
  name: () => Promise<string>;
  spawnProcess?: (command: string, args: string[]) => DaemonProcess;
}) {
  let generation = 0;
  let active: { child: DaemonProcess; revoke: () => Promise<void> } | null = null;
  const launch =
    input.spawnProcess ??
    ((command: string, args: string[]) =>
      spawn(command, args, {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      }) as ChildProcess as DaemonProcess);

  function stop() {
    generation++;
    const previous = active;
    active = null;
    if (previous) {
      previous.child.kill();
      void previous.revoke();
    }
  }

  return {
    stop,
    async select(rawOrigin: string | null, fetch: Fetch) {
      stop();
      const attempt = generation;
      const origin = secureHttpOrigin(rawOrigin ?? undefined);
      if (!origin) return;
      const valid = () => generation === attempt;
      let revoke: (() => Promise<void>) | undefined;
      try {
        const session = await currentSession(origin, fetch);
        if (!session || !valid()) return;
        const consent = await readDeviceConsent(input.userDataDir, origin);
        if (!valid() || consent?.consent !== "allowed" || consent.userId !== session.userId) return;
        const name = await input.name();
        if (!valid()) return;
        const response = await fetch(new URL("/daemon/login", origin).href, {
          method: "POST",
          credentials: "include",
          redirect: "error",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ desktop: true, name }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (
          !body ||
          typeof body !== "object" ||
          !("token" in body) ||
          typeof body.token !== "string" ||
          !body.token ||
          body.token.length > 1024
        )
          return;
        const token = body.token;
        revoke = async () => {
          try {
            const result = await fetch(new URL("/api/machines/self", origin).href, {
              method: "DELETE",
              credentials: "omit",
              redirect: "error",
              headers: { authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(10_000),
            });
            await result.body?.cancel();
          } catch {
            /* The server also binds the token to the session. */
          }
        };
        if (
          !("userId" in body) ||
          body.userId !== session.userId ||
          !("sessionId" in body) ||
          body.sessionId !== session.sessionId ||
          !valid()
        )
          return;
        const latest = await currentSession(origin, fetch);
        const choice = await readDeviceConsent(input.userDataDir, origin);
        if (
          !valid() ||
          latest?.userId !== session.userId ||
          latest.sessionId !== session.sessionId ||
          choice?.consent !== "allowed" ||
          choice.userId !== session.userId
        )
          return;
        const child = launch(
          input.entry.endsWith(".ts") ? "bun" : input.entry,
          daemonStartArgs(input.entry),
        );
        if (!child.stdin) {
          child.kill();
          return;
        }
        const instance = { child, revoke };
        active = instance;
        revoke = undefined;
        const ended = () => {
          if (active === instance) active = null;
          void instance.revoke();
        };
        child.once("error", ended);
        child.once("exit", ended);
        child.stdin.on("error", () => {
          if (active === instance) stop();
        });
        child.stdin.end(JSON.stringify({ server: origin, token, name } satisfies DaemonConfig));
      } catch {
        // An unavailable server or daemon must not take the window down.
      } finally {
        if (revoke) void revoke();
      }
    },
  };
}
