import path from "node:path";
import sharp from "sharp";
import type { RasterizedPage } from "./types";

// pdfjs-dist checks these end with a literal "/" regardless of OS — Node's
// fs still resolves forward-slash paths fine on Windows, so normalize here.
function toUrlDir(...segments: string[]): string {
  return path.join(...segments).split(path.sep).join("/") + "/";
}

async function rasterizePdf(buffer: Buffer): Promise<RasterizedPage[]> {
  // Everything here is dynamically imported instead of imported at module
  // scope: @napi-rs/canvas loads a native (.node) binding, which must not
  // run during Next.js's build-time "collecting page data" static analysis
  // pass — only when the route actually handles a request.
  const { createCanvas } = await import("@napi-rs/canvas");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const standardFontDataUrl = toUrlDir(pdfjsRoot, "standard_fonts");
  const cMapUrl = toUrlDir(pdfjsRoot, "cmaps");

  // pdfjs-dist auto-detects Node.js and uses @napi-rs/canvas internally
  // (see NodeCanvasFactory in the package) — no manual worker/canvas wiring
  // needed beyond providing width/height via canvasFactory.create().
  // standardFontDataUrl/cMapUrl point at the font & CJK charmap data that
  // ships inside the pdfjs-dist package itself, so PDFs using non-embedded
  // or CID fonts still render correctly.
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true,
  });
  const pdf = await loadingTask.promise;

  const pages: RasterizedPage[] = [];
  const scale = 200 / 72; // ~200 DPI; PDF user space defaults to 72 DPI

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);

    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");

    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    pages.push({ png: canvas.toBuffer("image/png"), width, height });
  }

  await loadingTask.destroy();
  return pages;
}

async function rasterizeImage(buffer: Buffer): Promise<RasterizedPage[]> {
  const image = sharp(buffer).rotate(); // rotate() auto-applies EXIF orientation
  const png = await image.png().toBuffer();
  const metadata = await sharp(png).metadata();
  return [
    {
      png,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
    },
  ];
}

export async function rasterizeDocument(filename: string, buffer: Buffer): Promise<RasterizedPage[]> {
  if (filename.toLowerCase().endsWith(".pdf")) {
    return rasterizePdf(buffer);
  }
  return rasterizeImage(buffer);
}
