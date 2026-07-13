import { createWorker } from "tesseract.js";
import type { OcrWord } from "./types";

export async function createOcrWorker() {
  return createWorker("por+eng");
}

/**
 * Flattens tesseract.js's blocks -> paragraphs -> lines -> words tree into a
 * flat, reading-order list of words with pixel bounding boxes. Words with
 * empty text are dropped (mirrors the Python pipeline's word filtering).
 */
export async function runOcr(worker: Awaited<ReturnType<typeof createWorker>>, pngBuffer: Buffer): Promise<OcrWord[]> {
  const { data } = await worker.recognize(pngBuffer, {}, { blocks: true });
  const words: OcrWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const text = word.text.trim();
          if (!text) continue;
          words.push({
            text,
            left: word.bbox.x0,
            top: word.bbox.y0,
            width: word.bbox.x1 - word.bbox.x0,
            height: word.bbox.y1 - word.bbox.y0,
          });
        }
      }
    }
  }
  return words;
}
