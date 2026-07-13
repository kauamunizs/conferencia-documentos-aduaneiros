import { extractEntities } from "./extract";
import { rasterizeDocument } from "./rasterize";
import { runOcr } from "./ocr";
import { FIELDS } from "./types";
import type { ExtractedEntities, FieldKey, OcrWord, RasterizedPage } from "./types";
import type { createWorker } from "tesseract.js";

export interface DocumentPages {
  pages: RasterizedPage[];
  ocr: OcrWord[][];
  entities: ExtractedEntities;
  entityPage: Partial<Record<FieldKey, number>>;
}

/**
 * Rasterizes every input file into pages, OCRs each page (for later bbox
 * lookup), and extracts entities page by page — the first non-null value
 * found for each field wins, mirroring the Python DocumentPages.extract().
 */
export async function buildDocument(
  files: { filename: string; buffer: Buffer }[],
  worker: Awaited<ReturnType<typeof createWorker>>
): Promise<DocumentPages> {
  const pages: RasterizedPage[] = [];
  const ocr: OcrWord[][] = [];

  for (const file of files) {
    const rasterized = await rasterizeDocument(file.filename, file.buffer);
    for (const page of rasterized) {
      pages.push(page);
      ocr.push(await runOcr(worker, page.png));
    }
  }

  const entities = {} as ExtractedEntities;
  for (const { key } of FIELDS) entities[key] = null;
  const entityPage: Partial<Record<FieldKey, number>> = {};

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const pageEntities = await extractEntities(pages[pageIndex].png);
    for (const { key } of FIELDS) {
      if (entities[key] === null && pageEntities[key]) {
        entities[key] = pageEntities[key];
        entityPage[key] = pageIndex;
      }
    }
  }

  return { pages, ocr, entities, entityPage };
}
