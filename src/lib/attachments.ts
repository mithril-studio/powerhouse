// Image attachments for ACP prompts.
//
// The persisted transcript keeps only lightweight references (id, name, mime,
// size); the base64 payload lives in a runtime-only cache so the single JSON
// tree written on every store change never carries megabytes of pixels. After
// a restart the thumbnail is gone but the chip still records what was sent —
// and agents that replay via session/load re-deliver the bytes as image chunks.
import type { ContentBlock } from "@agentclientprotocol/sdk";

export interface AttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  /** Decoded payload size in bytes. */
  bytes: number;
}

export interface Attachment extends AttachmentRef {
  /** Base64 payload (no data-URL prefix), as ACP expects. */
  data: string;
}

/** Largest image accepted per attachment. Above this, agents reject or stall. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
};

export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_BY_EXTENSION);

export const isImageMime = (mimeType: string) => mimeType.startsWith("image/");

/** MIME type for a file path, by extension; `null` when it is not an image. */
export function imageMimeForPath(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Bytes represented by a base64 string (padding-aware). */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

const dataCache = new Map<string, string>();

export const attachmentData = (id: string): string | undefined => dataCache.get(id);

export const dataUrl = (ref: AttachmentRef): string | undefined => {
  const data = dataCache.get(ref.id);
  return data ? `data:${ref.mimeType};base64,${data}` : undefined;
};

/** Registers a payload and returns the reference to persist. */
export function registerAttachment(input: {
  name: string;
  mimeType: string;
  data: string;
  id?: string;
}): AttachmentRef {
  const id = input.id ?? `att-${crypto.randomUUID()}`;
  dataCache.set(id, input.data);
  return { id, name: input.name, mimeType: input.mimeType, bytes: base64Bytes(input.data) };
}

export const toRef = ({ id, name, mimeType, bytes }: Attachment): AttachmentRef => ({
  id,
  name,
  mimeType,
  bytes,
});

/** Builds the ACP prompt: text first (when present), then one image block each. */
export function promptBlocks(text: string, attachments: Attachment[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });
  for (const attachment of attachments) {
    blocks.push({ type: "image", mimeType: attachment.mimeType, data: attachment.data });
  }
  return blocks;
}

export type AttachmentRejection = "not-image" | "too-large";

/** Validates a candidate before it is offered to the agent. */
export function rejectAttachment(input: {
  mimeType: string | null;
  bytes: number;
}): AttachmentRejection | null {
  if (!input.mimeType || !isImageMime(input.mimeType)) return "not-image";
  if (input.bytes > MAX_IMAGE_BYTES) return "too-large";
  return null;
}

export function rejectionMessage(name: string, reason: AttachmentRejection): string {
  return reason === "too-large"
    ? `${name} is larger than ${formatBytes(MAX_IMAGE_BYTES)} and was not attached.`
    : `${name} is not an image and was not attached.`;
}

/** Reads a browser File (paste or HTML5 drop) into an attachment. */
export function attachmentFromFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result);
      const data = result.slice(result.indexOf(",") + 1);
      const name = file.name || `pasted-image.${file.type.split("/")[1] ?? "png"}`;
      const ref = registerAttachment({ name, mimeType: file.type, data });
      resolve({ ...ref, data });
    };
    reader.readAsDataURL(file);
  });
}
