import { execFile } from "node:child_process";
import {
  actThenObserve,
  boundedHostScreenTree,
  HostScreenError,
  type HostScreen,
  type HostScreenAction,
  type HostScreenObservation,
  type HostScreenScope,
} from "./screen.ts";

/** Drives one X11 window with xdotool and a window screenshot. Needs a display on this machine. */
export function linuxScreen(): HostScreen {
  return {
    observe(_scope, app, options) {
      return observeWindow(app, options?.query);
    },
    async act(scope, app, actions) {
      return actThenObserve(
        scope.signal,
        actions,
        (action) => perform(app, action, scope.signal),
        () => observeWindow(app),
      );
    },
    async close() {},
  };
}

async function observeWindow(app: string, query?: string): Promise<HostScreenObservation> {
  const window = await findWindow(app);
  const image = await screenshot(window.id);
  const title = window.title;
  const matches = !query || title.toLowerCase().includes(query.toLowerCase());
  const tree = matches ? `[0] ${title} ${window.width}x${window.height}` : "";
  return {
    app,
    title,
    tree: boundedHostScreenTree(tree, false),
    ...(image ? { image } : {}),
  };
}

async function perform(app: string, action: HostScreenAction, signal: AbortSignal) {
  if (action.kind === "wait") {
    await new Promise((resolve) => setTimeout(resolve, action.ms));
    return;
  }
  const window = await findWindow(app);
  if (action.kind === "menu") {
    throw new HostScreenError("Menus are not available on this computer.");
  }
  if (action.kind === "click") {
    const x = action.x ?? Math.floor(window.width / 2);
    const y = action.y ?? Math.floor(window.height / 2);
    const button = action.button === "right" ? "3" : "1";
    await tool("xdotool", ["mousemove", "--window", window.id, String(x), String(y)], signal);
    await tool(
      "xdotool",
      ["click", "--window", window.id, "--repeat", action.double ? "2" : "1", button],
      signal,
    );
    return;
  }
  if (action.kind === "type" || action.kind === "set") {
    const text = action.kind === "set" ? action.value : action.text;
    await tool("xdotool", ["type", "--window", window.id, "--", text], signal);
    return;
  }
  if (action.kind === "key") {
    const modifiers = (action.modifiers ?? []).map((name) => (name === "cmd" || name === "option" ? "alt" : name));
    await tool("xdotool", ["key", "--window", window.id, [...modifiers, action.key].join("+")], signal);
    return;
  }
  const button = action.direction === "up" ? "4" : action.direction === "down" ? "5" : action.direction === "left" ? "6" : "7";
  if (action.x !== undefined && action.y !== undefined) {
    await tool("xdotool", ["mousemove", "--window", window.id, String(action.x), String(action.y)], signal);
  }
  await tool("xdotool", ["click", "--window", window.id, "--repeat", String(action.amount ?? 1), button], signal);
}

type Window = { id: string; title: string; width: number; height: number };

export async function findWindow(app: string): Promise<Window> {
  if (!process.env.DISPLAY) throw new HostScreenError("This computer has no display.");
  const ids = (await tool("xdotool", ["search", "--name", app])).split("\n").map((line) => line.trim()).filter(Boolean);
  const id = ids[0];
  if (!id) throw new HostScreenError(`No window named ${app} is open.`);
  const geometry = await tool("xdotool", ["getwindowgeometry", "--shell", id]);
  const title = (await tool("xdotool", ["getwindowname", id])).trim();
  return {
    id,
    title,
    width: numberFrom(geometry, "WIDTH"),
    height: numberFrom(geometry, "HEIGHT"),
  };
}

async function screenshot(window: Window): Promise<HostScreenObservation["image"]> {
  const png = await toolBuffer("import", ["-window", window.id, "png:-"]).catch(() => undefined);
  if (!png) return undefined;
  return { mimeType: "image/png", data: png.toString("base64"), width: window.width, height: window.height };
}

function numberFrom(text: string, name: string) {
  const match = new RegExp(`^${name}=(\\d+)$`, "m").exec(text);
  return match ? Number(match[1]) : 0;
}

function tool(command: string, args: string[], signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { signal, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new HostScreenError(stderr.trim() || `${command} is not available on this computer.`));
      else resolve(stdout);
    });
  });
}

function toolBuffer(command: string, args: string[]) {
  return new Promise<Buffer>((resolve, reject) => {
    execFile(command, args, { timeout: 15_000, encoding: "buffer" }, (error, stdout) => {
      if (error || !Buffer.isBuffer(stdout)) reject(error);
      else resolve(stdout);
    });
  });
}
