import { describe, expect, it } from "vitest";
import {
  attachmentData,
  base64Bytes,
  formatBytes,
  imageMimeForPath,
  MAX_IMAGE_BYTES,
  promptBlocks,
  registerAttachment,
  rejectAttachment,
} from "./attachments";

describe("attachments", () => {
  it("recognises image paths by extension, case-insensitively", () => {
    expect(imageMimeForPath("/tmp/Shot.PNG")).toBe("image/png");
    expect(imageMimeForPath("photo.jpeg")).toBe("image/jpeg");
    expect(imageMimeForPath("notes.txt")).toBeNull();
    expect(imageMimeForPath("noext")).toBeNull();
  });

  it("rejects non-images and oversized files before they reach the agent", () => {
    expect(rejectAttachment({ mimeType: "text/plain", bytes: 10 })).toBe("not-image");
    expect(rejectAttachment({ mimeType: null, bytes: 10 })).toBe("not-image");
    expect(rejectAttachment({ mimeType: "image/png", bytes: MAX_IMAGE_BYTES + 1 })).toBe(
      "too-large",
    );
    expect(rejectAttachment({ mimeType: "image/png", bytes: 1024 })).toBeNull();
  });

  it("measures base64 payloads and formats sizes", () => {
    expect(base64Bytes("aGk=")).toBe(2);
    expect(base64Bytes("aGVsbG8=")).toBe(5);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("keeps the payload out of the persisted reference", () => {
    const ref = registerAttachment({ name: "a.png", mimeType: "image/png", data: "aGk=" });
    expect(ref).toEqual({ id: ref.id, name: "a.png", mimeType: "image/png", bytes: 2 });
    expect(attachmentData(ref.id)).toBe("aGk=");
  });

  it("orders the prompt as text then images, and allows image-only prompts", () => {
    const image = { id: "x", name: "a.png", mimeType: "image/png", bytes: 2, data: "aGk=" };
    expect(promptBlocks("look", [image])).toEqual([
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", data: "aGk=" },
    ]);
    expect(promptBlocks("", [image])).toEqual([
      { type: "image", mimeType: "image/png", data: "aGk=" },
    ]);
  });
});
