import { expect, test } from "bun:test";
import { connect } from "node:net";
import { openBroker } from "./broker.ts";

test("claude 的审批代理问到 broker，窗口的答案写回去", async () => {
  const seen: string[] = [];
  const broker = await openBroker((ask) => {
    seen.push(ask.summary);
    broker.answer(ask.requestId, { behavior: "allow" });
  });
  const reply = await ask(broker.socketPath, {
    t: "ask",
    id: "a1",
    kind: "permission",
    tool: "Bash",
    input: { command: "rm -rf tmp" },
  });
  expect(seen).toEqual(["rm -rf tmp"]);
  expect(reply).toMatchObject({ t: "answer", id: "a1", behavior: "allow" });
  broker.close();
});

test("命令审批保留完整命令和工作目录", async () => {
  const command = `safe ${"x".repeat(220)}; unsafe`;
  const broker = await openBroker((request) => {
    expect(request.command).toBe(command);
    expect(request.cwd).toBe("/work");
    broker.answer(request.requestId, { behavior: "deny" });
  });
  try {
    await ask(broker.socketPath, {
      t: "ask",
      id: "long",
      kind: "permission",
      input: { command, cwd: "/work" },
    });
  } finally {
    broker.close();
  }
});

test("审批与问题不能用对方的行为作答", async () => {
  const broker = await openBroker((request) => {
    if (request.kind === "permission") {
      expect(broker.answer(request.requestId, { behavior: "answer", message: "yes" })).toBe(false);
      expect(broker.answer(request.requestId, { behavior: "deny" })).toBe(true);
    } else {
      expect(broker.answer(request.requestId, { behavior: "allow" })).toBe(false);
      expect(broker.answer(request.requestId, { behavior: "answer", message: " " })).toBe(false);
      expect(broker.answer(request.requestId, { behavior: "answer", message: "hello" })).toBe(true);
    }
  });
  try {
    expect(
      await ask(broker.socketPath, { t: "ask", id: "permission", kind: "permission" }),
    ).toMatchObject({ behavior: "deny" });
    expect(
      await ask(broker.socketPath, { t: "ask", id: "question", kind: "question" }),
    ).toMatchObject({ behavior: "answer", message: "hello" });
  } finally {
    broker.close();
  }
});

test("代理断开时使待处理审批失效", async () => {
  let closeClient!: () => void;
  const broker = await openBroker(() => closeClient());
  const conn = connect(broker.socketPath);
  closeClient = () => conn.end();
  conn.on("connect", () =>
    conn.write(`${JSON.stringify({ t: "ask", id: "lost", kind: "permission" })}\n`),
  );
  try {
    await new Promise<void>((resolve) => conn.on("close", resolve));
    expect(broker.answer("lost", { behavior: "allow" })).toBe(false);
  } finally {
    conn.destroy();
    broker.close();
  }
});

function ask(socketPath: string, value: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = connect(socketPath);
    conn.setEncoding("utf8");
    let buffer = "";
    conn.on("connect", () => conn.write(`${JSON.stringify(value)}\n`));
    conn.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      conn.end();
    });
    conn.on("error", reject);
  });
}
