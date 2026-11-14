import os from "node:os";
import path from "node:path";

/** 这台机器自己的状态，不进云端。 */
export function stateDir(): string {
  return process.env.RAKAZO_DAEMON_HOME ?? path.join(os.homedir(), ".rakazo", "daemon");
}

export const files = {
  config: () => path.join(stateDir(), "config.json"),
  sessions: () => path.join(stateDir(), "sessions.json"),
  pid: () => path.join(stateDir(), "daemon.pid"),
  log: () => path.join(stateDir(), "daemon.log"),
  errorLog: () => path.join(stateDir(), "daemon.err.log"),
};
