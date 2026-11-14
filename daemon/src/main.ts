import os from "node:os";
import { login } from "./login.ts";
import { start, status, stop } from "./service.ts";

const [command, arg, ...rest] = process.argv.slice(2);

if (command === "--permission-proxy") {
  await import("./permission-proxy.ts");
} else if (command === "login") {
  if (!arg) usage();
  await login(arg, rest[0] ?? os.hostname());
} else if (command === "start") {
  const flags = [arg, ...rest];
  const foreground = flags.includes("--foreground");
  if (flags.includes("--config-stdin")) {
    if (!foreground) {
      console.error("--config-stdin 需要 --foreground");
      process.exit(1);
    }
    await start(true, true);
  } else {
    await start(foreground);
  }
} else if (command === "status") {
  await status();
} else if (command === "stop") {
  await stop();
} else {
  usage();
}

function usage(): never {
  console.error(`用法：
  rakazo-daemon login <云端地址> [机器名]   把这台电脑连到账号
  rakazo-daemon start                       在后台连上云端，按 bot 拉起本机 agent
  rakazo-daemon status
  rakazo-daemon stop`);
  process.exit(1);
}
