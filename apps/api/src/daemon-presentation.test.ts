import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createDaemonPresentation, decodeDaemonFile } from "./daemon-presentation.js";

const run = { id: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" };
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
function setup() {
  const put = vi
    .fn()
    .mockResolvedValue({ id: "00000000-0000-4000-8000-000000000001", hash: "hash" });
  const artifact = {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async ({ data }) => ({
      id: "00000000-0000-4000-8000-000000000002",
      ...data,
    })),
  };
  const tx = { artifact, $queryRaw: vi.fn() };
  const prisma = {
    artifact,
    thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ groupId: null }) },
    $transaction: (work: (client: typeof tx) => unknown) => work(tx),
  } as unknown as PrismaClient;
  return { put, artifacts: { put } as unknown as ArtifactStore, prisma };
}

describe("daemon presentation boundary", () => {
  it("stores image bytes using only the active run's ownership", async () => {
    const { artifacts, prisma } = setup();
    const block = await createDaemonPresentation(prisma, artifacts, run, {
      kind: "image",
      name: "pixel.png",
      mimeType: "image/png",
      data: png,
    });
    expect(block).toEqual({
      kind: "image",
      artifactId: "00000000-0000-4000-8000-000000000002",
      name: "pixel.png",
      mimeType: "image/png",
    });
    expect(prisma.artifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "pixel.png",
        spaceId: "space",
        userId: "user",
        botId: "bot",
        runId: "run",
        storageKey: "00000000-0000-4000-8000-000000000001",
        mimeType: "image/png",
        size: Buffer.from(png, "base64").length,
      }),
    });
  });
  it("rejects client references and specialized business cards", async () => {
    const { put, artifacts, prisma } = setup();
    await expect(
      createDaemonPresentation(prisma, artifacts, run, {
        kind: "image",
        artifactId: "another-account",
      }),
    ).rejects.toThrow("references");
    await expect(
      createDaemonPresentation(prisma, artifacts, run, { kind: "ask", approvalEffectId: "forged" }),
    ).rejects.toThrow("references");
    await expect(
      createDaemonPresentation(prisma, artifacts, run, { kind: "purchase" }),
    ).rejects.toThrow("Unsupported");
    expect(put).not.toHaveBeenCalled();
  });
  it("rejects corrupt, oversized and mislabeled images", () => {
    for (const data of [
      "???",
      "A".repeat(6 * 1024 * 1024),
      Buffer.from("not an image").toString("base64"),
    ]) {
      expect(() =>
        decodeDaemonFile({ kind: "image", name: "pixel.png", mimeType: "image/png", data }),
      ).toThrow();
    }
    expect(() =>
      decodeDaemonFile({
        kind: "image",
        name: "pixel.svg",
        mimeType: "image/svg+xml",
        data: Buffer.from("<svg/>").toString("base64"),
      }),
    ).toThrow();
  });
  it("rejects corrupt image bytes submitted through a file descriptor", async () => {
    const { put, artifacts, prisma } = setup();
    await expect(
      createDaemonPresentation(prisma, artifacts, run, {
        kind: "file",
        name: "broken.png",
        mimeType: "image/png",
        data: Buffer.from("not an image").toString("base64"),
      }),
    ).rejects.toThrow("MIME type");
    expect(put).not.toHaveBeenCalled();
  });
  it("uses the existing app block without granting network or parent access", async () => {
    const { artifacts, prisma } = setup();
    const block = await createDaemonPresentation(prisma, artifacts, run, {
      kind: "app",
      html: "<h1>Local app</h1>",
      csp: { connectDomains: ["https://example.com"] },
      toolResult: { token: "untrusted" },
    });
    expect(block).toMatchObject({
      kind: "app",
      server: "local",
      tool: "present",
      toolArguments: {},
      toolResult: {},
    });
    expect(block).not.toHaveProperty("csp");
  });
  it("validates chart specifications using the shared contract", async () => {
    const { artifacts, prisma } = setup();
    const chart = {
      kind: "chart",
      name: "Example",
      spec: { marks: [{ type: "barY", options: { x: "label", y: "value" } }] },
      data: [{ label: "A", value: 1 }],
    };
    expect(await createDaemonPresentation(prisma, artifacts, run, chart)).toEqual(chart);
    await expect(
      createDaemonPresentation(prisma, artifacts, run, { ...chart, data: "invalid" }),
    ).rejects.toThrow();
  });
  it("creates a validated private page under the active bot", async () => {
    const { artifacts, prisma } = setup();
    const create = vi.fn().mockResolvedValue({ id: "page-id" });
    Object.assign(prisma, { page: { create } });
    const source = "export default function Page() { return <div>Hello</div>; }";
    expect(
      await createDaemonPresentation(prisma, artifacts, run, {
        kind: "page",
        title: "Example",
        source,
      }),
    ).toEqual({ kind: "page", pageId: "page-id", title: "Example", version: 1 });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spaceId: "space",
        userId: "user",
        botId: "bot",
        versions: { create: expect.objectContaining({ version: 1, source }) },
      }),
    });
  });
  it("stores files with the actual byte length", async () => {
    const { artifacts, prisma } = setup();
    const block = await createDaemonPresentation(prisma, artifacts, run, {
      kind: "file",
      name: "note.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello").toString("base64"),
      size: 999,
    });
    expect(block).toMatchObject({ kind: "file", size: 5 });
  });
});
