import { files } from "./paths.ts";

/** 会话 id 按 agent 和对话号分开存。换了 agent 不能拿另一个的会话去恢复。 */
export function sessionKey(agent: string, threadId: string): string {
  return `${agent}:${threadId}`;
}

/** agent 的会话 id 只存在这台电脑上。云端拿不到。 */
export async function readSessions(): Promise<Record<string, string>> {
  const file = Bun.file(files.sessions());
  if (!(await file.exists())) return {};
  const parsed: unknown = await file.json();
  if (!parsed || typeof parsed !== "object") return {};
  const sessions: Record<string, string> = {};
  for (const [threadId, sessionId] of Object.entries(parsed)) {
    if (typeof sessionId === "string") sessions[threadId] = sessionId;
  }
  return sessions;
}

export async function rememberSession(threadId: string, sessionId: string): Promise<void> {
  const sessions = await readSessions();
  sessions[threadId] = sessionId;
  await Bun.write(files.sessions(), JSON.stringify(sessions, null, 2));
}
