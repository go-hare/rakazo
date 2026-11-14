import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("start 退出后 daemon 还在后台，stop 能停掉", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rakazo-daemon-bg-"));
  const env = { ...process.env, RAKAZO_DAEMON_HOME: home };
  const config = path.join(home, "config.json");
  await Bun.write(
    config,
    JSON.stringify({ server: "http://127.0.0.1:9", token: "t", name: "测试机" }),
  );
  const started = await run(["start"], env);
  expect({ code: started.code, stderr: started.stderr }).toEqual({ code: 0, stderr: "" });
  expect(started.stdout).toContain("已在后台启动");
  const pid = Number(/pid (\d+)/.exec(started.stdout)?.[1]);
  expect(alive(pid)).toBe(true);

  await Bun.sleep(300);
  const status = await run(["status"], env);
  expect(status.stdout).toContain(`在跑（pid ${pid}）`);

  const stopped = await run(["stop"], env);
  expect(stopped.stdout).toContain("已停止");
  expect(alive(pid)).toBe(false);
  await rm(home, { recursive: true, force: true });
});

test("stdin 配置只在前台内存中使用，不影响已有 CLI 状态", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rakazo-daemon-stdin-"));
  const token = "stdin-secret-for-test";
  let receivedAuthorization: string | null = null;
  let receivedHello = "";
  let resolveHello!: () => void;
  const hello = new Promise<void>((resolve) => {
    resolveHello = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      receivedAuthorization = request.headers.get("authorization");
      return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      message(_socket, message) {
        receivedHello = String(message);
        resolveHello();
      },
    },
  });
  const config = JSON.stringify({ server: server.url.origin, token, name: "桌面" });
  const existingConfig = JSON.stringify({
    server: "http://127.0.0.1:8",
    token: "existing",
    name: "CLI",
  });
  await Bun.write(path.join(home, "config.json"), existingConfig);
  await Bun.write(path.join(home, "daemon.pid"), String(process.pid));
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dir, "main.ts"), "start", "--foreground", "--config-stdin"],
    {
      env: { ...process.env, RAKAZO_DAEMON_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  try {
    child.stdin.end(config);
    await Promise.race([
      hello,
      Bun.sleep(3000).then(() => {
        throw new Error("daemon did not connect");
      }),
    ]);
    expect<string | null>(receivedAuthorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(receivedHello)).toMatchObject({ type: "hello", name: "桌面" });
    expect(child.exitCode).toBeNull();
    expect(await Bun.file(path.join(home, "config.json")).text()).toBe(existingConfig);
    expect(await Bun.file(path.join(home, "daemon.pid")).text()).toBe(String(process.pid));
    expect(await Bun.file(path.join(home, "daemon.log")).exists()).toBe(false);
    expect(output).not.toContain(token);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});

test("stdin 配置错误时不泄露输入", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "rakazo-daemon-invalid-"));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "main.ts"),
        "start",
        "--foreground",
        "--config-stdin",
      ],
      {
        env: { ...process.env, RAKAZO_DAEMON_HOME: home },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const invalidInput = '{"token":"invalid-value"';
    child.stdin.write(invalidInput);
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout + stderr).not.toContain("invalid-value");
    expect(await Bun.file(path.join(home, "config.json")).exists()).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dir, "main.ts"), ...args], {
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
