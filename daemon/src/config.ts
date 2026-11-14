import { files } from "./paths.ts";

export interface DaemonConfig {
  /** 云端地址，例如 https://cloud.example.com */
  server: string;
  /** rakazo-daemon login 拿到的机器 token。 */
  token: string;
  /** 这台电脑在账号里的名字。 */
  name: string;
}

export async function readConfig(): Promise<DaemonConfig | null> {
  const file = Bun.file(files.config());
  if (!(await file.exists())) return null;
  const parsed: unknown = await file.json();
  if (!isConfig(parsed)) return null;
  return parsed;
}

export async function writeConfig(config: DaemonConfig): Promise<void> {
  await Bun.write(files.config(), JSON.stringify(config, null, 2));
}

function isConfig(value: unknown): value is DaemonConfig {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.server === "string" && typeof record.token === "string" && typeof record.name === "string";
}
