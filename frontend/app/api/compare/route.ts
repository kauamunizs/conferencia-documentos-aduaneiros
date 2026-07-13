import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { buildDocument } from "@/lib/document";
import { createOcrWorker } from "@/lib/ocr";
import { locateBbox } from "@/lib/locate-bbox";
import { valuesMatch } from "@/lib/normalize";
import { FIELDS } from "@/lib/types";
import type { CompareResponse, FieldComparison, PageImage } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

async function fileToBuffer(file: File): Promise<Buffer> {
  return Buffer.from(await file.arrayBuffer());
}

function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const referenceFiles = formData.getAll("reference_files").filter((v): v is File => v instanceof File);
  const producedFileEntry = formData.get("produced_file");

  if (referenceFiles.length === 0) {
    return NextResponse.json({ detail: "Nenhum arquivo de referência enviado." }, { status: 400 });
  }
  if (!(producedFileEntry instanceof File)) {
    return NextResponse.json({ detail: "Nenhum arquivo de documento produzido enviado." }, { status: 400 });
  }

  const worker = await createOcrWorker();

  try {
    const referenceInputs = await Promise.all(
      referenceFiles.map(async (file) => ({ filename: file.name, buffer: await fileToBuffer(file) }))
    );
    const producedInputs = [{ filename: producedFileEntry.name, buffer: await fileToBuffer(producedFileEntry) }];

    let referenceDoc, producedDoc;
    try {
      referenceDoc = await buildDocument(referenceInputs, worker);
      producedDoc = await buildDocument(producedInputs, worker);
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        return NextResponse.json(
          { detail: "Chave da API Anthropic inválida ou ausente (ANTHROPIC_API_KEY)." },
          { status: 502 }
        );
      }
      if (error instanceof Anthropic.APIError) {
        return NextResponse.json({ detail: `Erro ao chamar a Claude Vision: ${error.message}` }, { status: 502 });
      }
      throw error;
    }

    if (referenceDoc.pages.length === 0) {
      return NextResponse.json(
        { detail: "Nenhuma página válida encontrada nos documentos de referência." },
        { status: 400 }
      );
    }
    if (producedDoc.pages.length === 0) {
      return NextResponse.json(
        { detail: "Nenhuma página válida encontrada no documento produzido." },
        { status: 400 }
      );
    }

    const fields: FieldComparison[] = [];
    let overallMatch = true;

    for (const { key, label } of FIELDS) {
      const referenceValue = referenceDoc.entities[key];
      const producedValue = producedDoc.entities[key];
      const match = valuesMatch(key, referenceValue, producedValue);
      overallMatch = overallMatch && match;

      const referencePageIndex = referenceDoc.entityPage[key];
      const referenceBoundingBox =
        referencePageIndex !== undefined
          ? locateBbox(
              referenceDoc.ocr[referencePageIndex],
              referenceValue,
              referencePageIndex,
              referenceDoc.pages[referencePageIndex].width,
              referenceDoc.pages[referencePageIndex].height
            )
          : null;

      const producedPageIndex = producedDoc.entityPage[key];
      const producedBoundingBox =
        producedPageIndex !== undefined
          ? locateBbox(
              producedDoc.ocr[producedPageIndex],
              producedValue,
              producedPageIndex,
              producedDoc.pages[producedPageIndex].width,
              producedDoc.pages[producedPageIndex].height
            )
          : null;

      fields.push({
        key,
        label,
        referenceValue,
        producedValue,
        match,
        referenceBoundingBox,
        producedBoundingBox,
      });
    }

    const referencePages: PageImage[] = referenceDoc.pages.map((page, index) => ({
      page: index,
      dataUrl: toDataUrl(page.png),
      width: page.width,
      height: page.height,
    }));
    const producedPages: PageImage[] = producedDoc.pages.map((page, index) => ({
      page: index,
      dataUrl: toDataUrl(page.png),
      width: page.width,
      height: page.height,
    }));

    const result: CompareResponse = { overallMatch, fields, referencePages, producedPages };
    return NextResponse.json(result);
  } finally {
    await worker.terminate();
  }
}
