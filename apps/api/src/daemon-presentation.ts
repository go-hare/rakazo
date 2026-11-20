import type { ArtifactStore } from "@rakazo/adapter-kit";
import {
  attachWorkspaceFileToThread,
  storeMcpAppHtml,
  validatePlotPresentation,
} from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { MessageBlock as BlockSchema, PageTitleSchema } from "@rakazo/contracts";
import { inferAttachmentMimeType } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { checkPageSource } from "@rakazo/page-kit/validate";

export interface DaemonPresentationContext {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
}

const MAX_BYTES = 4 * 1024 * 1024;

export function decodeDaemonFile(value: unknown): {
  name: string;
  mimeType: string;
  bytes: Buffer;
} {
  if (!value || typeof value !== "object") throw new Error("Invalid presentation");
  const input = value as Record<string, unknown>;
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 200 ||
    /[\\/]/.test(input.name) ||
    [...input.name].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Invalid file name");
  if (typeof input.mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType))
    throw new Error("Invalid MIME type");
  if (
    typeof input.data !== "string" ||
    input.data.length > Math.ceil(MAX_BYTES / 3) * 4 ||
    input.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)
  )
    throw new Error("Invalid base64 file");
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString("base64") !== input.data)
    throw new Error("File exceeds the size limit or is empty");
  if (input.kind === "image" || input.mimeType.startsWith("image/")) {
    const valid =
      input.mimeType === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : input.mimeType === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : input.mimeType === "image/gif"
            ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())
            : input.mimeType === "image/webp"
              ? bytes.subarray(0, 4).toString() === "RIFF" &&
                bytes.subarray(8, 12).toString() === "WEBP"
              : false;
    if (!valid) throw new Error("Unsupported image or MIME type does not match its bytes");
  }
  return { name: input.name, mimeType: input.mimeType, bytes };
}

export async function createDaemonPresentation(
  prisma: PrismaClient,
  artifacts: ArtifactStore,
  run: DaemonPresentationContext,
  value: unknown,
): Promise<MessageBlock> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid presentation");
  const input = value as Record<string, unknown>;
  if (["artifactId", "pageId", "botId", "spaceId", "approvalEffectId"].some((key) => key in input))
    throw new Error("Presentation references are created by the server");
  const ownership = async () => {
    const thread = await prisma.thread.findUniqueOrThrow({
      where: { id: run.threadId },
      select: { groupId: true },
    });
    return {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      runId: run.id,
      groupId: thread.groupId ?? undefined,
      operationId: run.id,
    };
  };
  if (input.kind === "image" || input.kind === "file") {
    const file = decodeDaemonFile(input);
    if (inferAttachmentMimeType(file.name) !== file.mimeType)
      throw new Error("File extension does not match its MIME type");
    const attached = await attachWorkspaceFileToThread(
      { prisma, artifacts, maxUploadSizeBytes: MAX_BYTES },
      { ...(await ownership()), filePath: file.name, name: file.name, bytes: file.bytes },
    );
    return attached.block;
  }
  if (input.kind === "chart") {
    const block = BlockSchema.parse(input);
    if (block.kind !== "chart") throw new Error("Invalid chart");
    await validatePlotPresentation(block.spec, block.data);
    return block;
  }
  if (input.kind === "app") {
    if (typeof input.html !== "string" || !input.html || Buffer.byteLength(input.html) > MAX_BYTES)
      throw new Error("Invalid app HTML");
    const artifactId = await storeMcpAppHtml(
      { prisma, artifacts },
      { ...(await ownership()), server: "local", html: input.html },
    );
    return {
      kind: "app",
      artifactId,
      server: "local",
      tool: "present",
      toolArguments: {},
      toolResult: {},
    };
  }
  if (input.kind === "page") {
    const title = PageTitleSchema.parse(input.title);
    if (typeof input.source !== "string" || Buffer.byteLength(input.source) > MAX_BYTES)
      throw new Error("Invalid page source");
    const check = checkPageSource(input.source);
    if (!check.ok) throw new Error(`Invalid page source: ${check.errors.join("; ")}`);
    const thread = await prisma.thread.findUniqueOrThrow({
      where: { id: run.threadId },
      select: { groupId: true },
    });
    const page = await prisma.page.create({
      data: {
        spaceId: run.spaceId,
        userId: run.userId,
        botId: run.botId,
        groupId: thread.groupId,
        title,
        versions: { create: { version: 1, title, source: input.source, code: check.code } },
      },
    });
    return { kind: "page", pageId: page.id, title, version: 1 };
  }
  throw new Error("Unsupported presentation kind");
}
