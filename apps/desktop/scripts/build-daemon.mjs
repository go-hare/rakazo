import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.versions.bun) throw new Error("Run this script with Bun");

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, "apps/desktop/build/daemon");
const targets = process.argv.includes("--all")
  ? ["darwin-arm64", "darwin-x64", "linux-x64", "windows-x64"]
  : process.argv.includes("--mac-universal")
    ? ["darwin-arm64", "darwin-x64"]
    : [`${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`];
mkdirSync(output, { recursive: true });
for (const target of targets) {
  const result = spawnSync(
    process.execPath,
    [
      "build",
      path.join(root, "daemon/src/main.ts"),
      "--compile",
      `--target=bun-${target}`,
      "--outfile",
      path.join(output, `rakazo-daemon-${target}${target.startsWith("windows-") ? ".exe" : ""}`),
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
