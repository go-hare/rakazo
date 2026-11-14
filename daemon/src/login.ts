import { writeConfig } from "./config.ts";

/**
 * 登录我们自己的云端账号，不是登录 Claude。
 * 云端的登录页把机器 token 回传到本机这个端口。
 */
export async function login(server: string, name: string): Promise<void> {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const listener = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const token = new URL(request.url).searchParams.get("token");
      if (!token) return new Response("缺少 token", { status: 400 });
      await writeConfig({ server, token, name });
      console.log("已登录", server);
      queueMicrotask(() => {
        listener.stop();
        resolveDone();
      });
      return new Response("这台电脑已连到你的账号，可以关闭这个页面。");
    },
  });
  const callback = `http://127.0.0.1:${listener.port}`;
  const page = new URL("/daemon/login", server);
  page.searchParams.set("callback", callback);
  page.searchParams.set("name", name);
  console.log("在浏览器里打开：");
  console.log(page.toString());
  await done;
}
