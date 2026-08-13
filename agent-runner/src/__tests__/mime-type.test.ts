import { describe, it, expect } from "vitest";
import { detectMimeType } from "../mcp-file.js";

describe("detectMimeType", () => {
  it("returns image/png for .png", () => {
    expect(detectMimeType("/tmp/photo.png")).toBe("image/png");
  });

  it("returns image/jpeg for .jpg and .jpeg", () => {
    expect(detectMimeType("/tmp/photo.jpg")).toBe("image/jpeg");
    expect(detectMimeType("/tmp/photo.jpeg")).toBe("image/jpeg");
  });

  it("matches extension case-insensitively", () => {
    expect(detectMimeType("/tmp/PHOTO.PNG")).toBe("image/png");
    expect(detectMimeType("/tmp/Doc.PDF")).toBe("application/pdf");
  });

  it("uses the final extension when filename has multiple dots", () => {
    expect(detectMimeType("/tmp/archive.tar.gz")).toBe("application/gzip");
    expect(detectMimeType("/tmp/v1.2.3.zip")).toBe("application/zip");
  });

  it("returns application/octet-stream for unknown extensions", () => {
    expect(detectMimeType("/tmp/data.xyz")).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for files without extension", () => {
    expect(detectMimeType("/tmp/README")).toBe("application/octet-stream");
  });

  it("returns expected mime for common document types", () => {
    expect(detectMimeType("a.pdf")).toBe("application/pdf");
    expect(detectMimeType("a.json")).toBe("application/json");
    expect(detectMimeType("a.csv")).toBe("text/csv");
    expect(detectMimeType("a.txt")).toBe("text/plain");
  });

  it("returns expected mime for media types", () => {
    expect(detectMimeType("a.mp3")).toBe("audio/mpeg");
    expect(detectMimeType("a.mp4")).toBe("video/mp4");
    expect(detectMimeType("a.wav")).toBe("audio/wav");
    expect(detectMimeType("a.ogg")).toBe("audio/ogg");
  });

  it("returns image/svg+xml for .svg", () => {
    expect(detectMimeType("logo.svg")).toBe("image/svg+xml");
  });

  it("falls back for SVG without extension match (e.g. .svgz)", () => {
    expect(detectMimeType("logo.svgz")).toBe("application/octet-stream");
  });
});
