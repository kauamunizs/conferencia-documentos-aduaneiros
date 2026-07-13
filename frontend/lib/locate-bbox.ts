import { normalizeText } from "./normalize";
import type { BoundingBox, OcrWord } from "./types";

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function similarityRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function windowSimilarity(words: OcrWord[], start: number, end: number, targetNorm: string): number {
  const windowText = normalizeText(words.slice(start, end).map((w) => w.text).join(" ")) ?? "";
  return similarityRatio(windowText, targetNorm);
}

/**
 * Locate the bounding box of targetText within the OCR word list via fuzzy
 * matching. Tests multiple window sizes and trims the edges of the best
 * match — this avoids a fixed-size window "stealing" part of a neighboring
 * field's box when two fields sit on the same line (e.g. Peso Bruto / Peso
 * Líquido side by side).
 */
export function locateBbox(
  words: OcrWord[],
  targetText: string | null,
  page: number,
  imageWidth: number,
  imageHeight: number
): BoundingBox | null {
  if (!targetText || words.length === 0) return null;
  const targetNorm = normalizeText(targetText) ?? "";
  if (!targetNorm) return null;
  const targetWordCount = Math.max(1, targetNorm.split(" ").length);

  let bestScore = -1;
  let bestStart = 0;
  let bestEnd = 0;

  const candidateSizes = Array.from(
    new Set([targetWordCount, targetWordCount + 1, targetWordCount + 2, Math.max(1, targetWordCount - 1)])
  );

  for (const size of candidateSizes) {
    if (size <= 0 || size > words.length) continue;
    for (let start = 0; start <= words.length - size; start++) {
      const end = start + size;
      const score = windowSimilarity(words, start, end, targetNorm);
      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
        bestEnd = end;
      }
    }
  }

  if (bestScore < 0.4) return null;

  // Trim edges: shrink the window while similarity doesn't drop.
  while (bestEnd - bestStart > 1) {
    const trimmedLeft = windowSimilarity(words, bestStart + 1, bestEnd, targetNorm);
    const trimmedRight = windowSimilarity(words, bestStart, bestEnd - 1, targetNorm);
    if (trimmedLeft >= bestScore) {
      bestStart += 1;
      bestScore = trimmedLeft;
    } else if (trimmedRight >= bestScore) {
      bestEnd -= 1;
      bestScore = trimmedRight;
    } else {
      break;
    }
  }

  const windowWords = words.slice(bestStart, bestEnd);
  const left = Math.min(...windowWords.map((w) => w.left));
  const top = Math.min(...windowWords.map((w) => w.top));
  const right = Math.max(...windowWords.map((w) => w.left + w.width));
  const bottom = Math.max(...windowWords.map((w) => w.top + w.height));

  return {
    page,
    x: left / imageWidth,
    y: top / imageHeight,
    width: (right - left) / imageWidth,
    height: (bottom - top) / imageHeight,
  };
}
