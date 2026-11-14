// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listDaemonMachines, pinDaemonMachine } from "../lib/daemon-machines";
import { rpc } from "../lib/rpc";
import { ComputerDeviceSettings } from "./ComputerDeviceSettings";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));
vi.mock("../lib/daemon-machines", () => ({
  listDaemonMachines: vi.fn(),
  pinDaemonMachine: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: { bots: { list: vi.fn(async () => []), update: vi.fn() } },
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const laptop = { id: "m1", name: "Laptop", online: true, cwd: "" };

it("lists a connected daemon and does not offer the old computer command", async () => {
  vi.mocked(listDaemonMachines).mockResolvedValue({ machines: [laptop], pins: {} });
  await act(async () => root.render(<ComputerDeviceSettings />));
  expect(host.textContent).toContain("Laptop");
  expect(host.textContent).toContain("Connected");
  expect(host.textContent).toContain("rakazo-daemon login");
  expect(host.textContent).not.toContain("host-computer");
  expect(host.textContent).not.toContain("Most recently connected");
});

it("switches a pinned bot back to the server", async () => {
  vi.mocked(listDaemonMachines).mockResolvedValue({
    machines: [laptop],
    pins: { "bot-1": { machineId: "m1", cwd: "/work/scout", agent: "claude" } },
  });
  vi.mocked(rpc.bots.list).mockResolvedValue([{ id: "bot-1", name: "Scout" }] as Awaited<
    ReturnType<typeof rpc.bots.list>
  >);
  vi.mocked(pinDaemonMachine).mockResolvedValue();
  await act(async () => root.render(<ComputerDeviceSettings />));
  const select = host.querySelector("select");
  if (select) select.value = "";
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(pinDaemonMachine).toHaveBeenCalledWith("bot-1", "", "/work/scout", "claude");
});

it("pins a bot to a machine and directory", async () => {
  vi.mocked(listDaemonMachines).mockResolvedValue({ machines: [laptop], pins: {} });
  vi.mocked(rpc.bots.list).mockResolvedValue([{ id: "bot-1", name: "Scout" }] as Awaited<
    ReturnType<typeof rpc.bots.list>
  >);
  vi.mocked(pinDaemonMachine).mockResolvedValue();
  await act(async () => root.render(<ComputerDeviceSettings />));
  const select = host.querySelector("select");
  const input = host.querySelector("input");
  expect(select?.getAttribute("aria-label")).toBe("Scout runs on");
  if (select) select.value = "m1";
  if (input) input.value = "/work/scout";
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(pinDaemonMachine).toHaveBeenCalledWith("bot-1", "m1", "/work/scout", "claude");
});
