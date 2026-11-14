import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DaemonConfig } from "./config.ts";
import { readConfig } from "./config.ts";
import { connect } from "./connection.ts";
import { files, stateDir } from "./paths.ts";

export async function start(foreground = false, configStdin = false): Promise<void> {
  if (configStdin) {
    const config = await readStdinConfig();
    if (!config) {
      console.error("stdin 配置无效");
      process.exitCode = 1;
      return;
    }
    await serve(config, false);
    return;
  }
  const config = await readConfig();
  if (!config) {
    console.error("还没登录。先运行：rakazo-daemon login <云端地址>");
    process.exit(1);
  }
  const running = await readPid();
  // 父进程先把 pid 写进文件，子进程起来时读到的就是自己。
  if (running && running !== process.pid && alive(running)) {
    console.log("已经在跑，pid", running);
    return;
  }
  if (foreground) {
    await serve(config, true);
    return;
  }
  mkdirSync(stateDir(), { recursive: true });
  detach(process.execPath, [...childArgs(), "--foreground"], process.cwd());
  const pid = await waitForChildPid();
  console.log("rakazo-daemon 已在后台启动，pid", pid, "机器", config.name);
}

async function readStdinConfig(): Promise<DaemonConfig | null> {
  try {
    const value: unknown = JSON.parse(await Bun.stdin.text());
    if (!value || typeof value !== "object") return null;
    const { server, token, name } = value as Record<string, unknown>;
    if (
      typeof server !== "string" ||
      typeof token !== "string" ||
      !token ||
      typeof name !== "string" ||
      !name
    )
      return null;
    const url = new URL(server);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
      return null;
    return { server: url.origin, token, name };
  } catch {
    return null;
  }
}

/** 真正连云端的那一个进程。前台启动时直接跑，后台启动时由 detach 拉起。 */
async function serve(config: DaemonConfig, persistState: boolean): Promise<void> {
  if (!persistState) {
    const signal = new AbortController();
    const stop = () => signal.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await connect(config, signal.signal);
    return;
  }
  await Bun.write(files.pid(), String(process.pid));
  const log = Bun.file(files.log()).writer();
  const write = (chunk: string) => void log.write(chunk);
  const stdout = console.log;
  const stderr = console.error;
  console.log = (...args) => {
    stdout(...args);
    write(`${args.join(" ")}\n`);
  };
  console.error = (...args) => {
    stderr(...args);
    write(`${args.join(" ")}\n`);
  };
  console.log("rakazo-daemon 启动，pid", process.pid, "机器", config.name);
  const signal = new AbortController();
  const stop = () => signal.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await connect(config, signal.signal);
  await Bun.write(files.pid(), "");
}

export async function status(): Promise<void> {
  const config = await readConfig();
  const pid = await readPid();
  console.log("云端：", config ? config.server : "未登录");
  console.log("机器：", config ? config.name : "—");
  console.log("daemon：", pid && alive(pid) ? `在跑（pid ${pid}）` : "没在跑");
}

export async function stop(): Promise<void> {
  const pid = await readPid();
  if (!pid || !alive(pid)) {
    console.log("没在跑");
    await Bun.write(files.pid(), "");
    return;
  }
  process.kill(pid);
  const stopped = await waitUntilDead(pid);
  if (stopped) await Bun.write(files.pid(), "");
  console.log(stopped ? "已停止" : "已发出停止，进程还在", pid);
}

/** 父进程退出后子进程还在。Windows 用 Start-Process；别的系统 detached。 */
export function detach(exe: string, args: string[], cwd: string): void {
  if (process.platform === "win32") {
    detachWindows(exe, args, cwd);
    return;
  }
  const child = spawn(exe, args, { cwd, detached: true, stdio: "ignore" });
  child.unref();
}

function detachWindows(exe: string, args: string[], cwd: string): void {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const list = args.map((arg) => quote(arg)).join(", ");
  const command = [
    `Start-Process -FilePath ${quote(exe)} -ArgumentList @(${list})`,
    `-WorkingDirectory ${quote(cwd)} -WindowStyle Hidden`,
  ].join(" ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error((result.stderr ?? "").trim() || "后台启动失败");
}

/** Windows 的 Start-Process 返回的是 powershell 自己的 pid。真正的 daemon 把自己的 pid 写进文件。 */
async function waitForChildPid(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pid = await readPid();
    if (pid && pid !== process.pid && alive(pid)) return pid;
    await Bun.sleep(100);
  }
  throw new Error("后台进程没有写 pid");
}

async function readPid(): Promise<number | null> {
  const file = Bun.file(files.pid());
  if (!(await file.exists())) return null;
  const pid = Number((await file.text()).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** bun src/main.ts 要带上脚本；编成单个 exe 之后参数就是 start。 */
function childArgs(): string[] {
  const entry = process.argv[1];
  if (entry && (entry.endsWith(".ts") || entry.includes("/") || entry.includes("\\"))) {
    return [path.resolve(entry), "start"];
  }
  return ["start"];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!alive(pid)) return true;
    await Bun.sleep(100);
  }
  return !alive(pid);
}
