import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrokerAnswer, BrokerAsk } from "./broker.ts";
import { openBroker } from "./broker.ts";

interface ProxyReply {
  jsonrpc: string;
  id: number;
  result: { content: Array<{ type: string; text: string }> };
}

const input = {
  command: "echo approval-test",
  cwd: tmpdir(),
  description: "Approval round trip",
};

for (const behavior of ["allow", "deny"] as const) {
  test(`main 的审批代理将请求交给 broker 并返回 ${behavior}`, async () => {
    const received: BrokerAsk[] = [];
    const answer: BrokerAnswer = { behavior, message: "Approval decision" };
    const broker = await openBroker((ask) => {
      received.push(ask);
      broker.answer(ask.requestId, answer);
    });
    try {
      const reply = await callProxy(broker.socketPath);
      expect(received).toEqual([
        {
          requestId: expect.any(String),
          kind: "permission",
          tool: "Bash",
          summary: input.command,
          command: input.command,
          cwd: input.cwd,
        },
      ]);
      expect(reply).toMatchObject({ jsonrpc: "2.0", id: 1 });
      expect(reply.result.content).toHaveLength(1);
      expect(reply.result.content[0]?.type).toBe("text");
      expect(JSON.parse(reply.result.content[0]?.text ?? "")).toEqual(
        behavior === "allow"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: answer.message },
      );
    } finally {
      broker.close();
    }
  });
}

test("main 的审批代理在 broker 确实不存在时拒绝请求", async () => {
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\rakazo-perm-missing-${randomUUID()}`
      : join(tmpdir(), `rakazo-perm-missing-${randomUUID()}.sock`);
  const reply = await callProxy(socketPath);
  expect(reply).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        { type: "text", text: JSON.stringify({ behavior: "deny", message: "审批服务没连上" }) },
      ],
    },
  });
});

function callProxy(socketPath: string): Promise<ProxyReply> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "main.ts"), "--permission-proxy", socketPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Permission proxy did not answer: ${stderr}`));
    }, 3000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) child.stdin.end();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Permission proxy exited with ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as ProxyReply);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "approve", arguments: { tool_name: "Bash", input } },
      })}\n`,
    );
  });
}
