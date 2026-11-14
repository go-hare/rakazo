export {};

const kind = process.argv[2] ?? "claude";
const decoder = new TextDecoder();
const input = Bun.stdin.stream().getReader();
let buffer = "";
let grokSession = false;
let id = 0;

for (;;) {
  const chunk = await input.read();
  if (chunk.done) break;
  buffer += decoder.decode(chunk.value, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line) reply(JSON.parse(line) as Record<string, unknown>);
  }
}

function reply(message: Record<string, unknown>): void {
  if (kind === "claude") {
    const text = ((message.message as { content?: string } | undefined)?.content) ?? "";
    write({ type: "system", subtype: "init", session_id: "claude-session" });
    write({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `claude:${text}` } } });
    write({ type: "result" });
    return;
  }
  const method = message.method;
  if (method === "initialize" || method === "initialized") {
    if (typeof message.id === "number") write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (method === "session/set_model") {
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (method === "session/new") {
    grokSession = true;
    write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "grok-session" } });
    return;
  }
  if (method === "session/prompt" && grokSession) {
    const prompt = (message.params as { prompt?: Array<{ text?: string }> }).prompt?.[0]?.text ?? "";
    id = Number(message.id);
    write({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `grok:${prompt}` } } } });
    write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
