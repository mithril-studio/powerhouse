import { describe, expect, it } from "vitest";
import { chatImageSource } from "./chatImage";

describe("chatImageSource", () => {
  it("accepts embedded raster images", () => {
    expect(chatImageSource("image/png", "aGVsbG8=")).toBe("data:image/png;base64,aGVsbG8=");
  });
  it("rejects active formats, malformed data and oversized payloads", () => {
    expect(chatImageSource("image/svg+xml", "aGVsbG8=")).toBeNull();
    expect(chatImageSource("text/html", "aGVsbG8=")).toBeNull();
    expect(chatImageSource("image/png", "https://example.com/image.png")).toBeNull();
    expect(chatImageSource("image/png", "")).toBeNull();
    expect(chatImageSource("image/png", "a".repeat(8 * 1024 * 1024 + 4))).toBeNull();
  });
});
