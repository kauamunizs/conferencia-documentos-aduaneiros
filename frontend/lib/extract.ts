import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { FIELDS } from "./types";
import type { ExtractedEntities } from "./types";
import { SYSTEM_PROMPT } from "./system-prompt";

const MODEL = "claude-opus-4-8";

// MOCK_MODE defaults to true: the app never calls the Anthropic API unless
// you explicitly set MOCK_MODE=false and provide a real ANTHROPIC_API_KEY.
// Mirrors the same switch used in the (retired) Python backend.
const MOCK_MODE = (process.env.MOCK_MODE ?? "true").trim().toLowerCase() !== "false";

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

// Canned values used only when MOCK_MODE is on, so the full upload -> compare
// -> report flow can be exercised without ever spending API credits. They
// alternate per call so the report shows a realistic mix of matches and
// mismatches — they do NOT reflect what's actually written on the uploaded
// documents.
const MOCK_ENTITIES: ExtractedEntities[] = [
  {
    cnpj: "12.345.678/0001-90",
    razaoSocial: "EMPRESA EXEMPLO LTDA",
    endereco: "Rua Exemplo, 100 - Sao Paulo - SP",
    pesoBruto: "1.000,000 KG",
    pesoLiquido: "950,000 KG",
    valorTotal: "R$ 10.000,00",
  },
  {
    cnpj: "12.345.678/0001-90",
    razaoSocial: "Empresa Exemplo Ltda.",
    endereco: "Rua Exemplo, 100 - Sao Paulo/SP",
    pesoBruto: "1000.0 KG",
    pesoLiquido: "900,000 KG",
    valorTotal: "USD 10000.00",
  },
];
let mockCallCount = 0;

function parseJsonResponse(text: string): ExtractedEntities {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = {};
  }
  const result = {} as ExtractedEntities;
  for (const { key } of FIELDS) {
    const value = parsed[key];
    result[key] = typeof value === "string" ? value : null;
  }
  return result;
}

export async function extractEntities(pngBuffer: Buffer): Promise<ExtractedEntities> {
  if (MOCK_MODE) {
    const entities = MOCK_ENTITIES[mockCallCount % MOCK_ENTITIES.length];
    mockCallCount += 1;
    return { ...entities };
  }

  const jpegBuffer = await sharp(pngBuffer).jpeg({ quality: 85 }).toBuffer();

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: jpegBuffer.toString("base64"),
            },
          },
          { type: "text", text: "Extraia os campos desta página conforme instruído." },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const text = textBlock && textBlock.type === "text" ? textBlock.text : "{}";
  return parseJsonResponse(text);
}
