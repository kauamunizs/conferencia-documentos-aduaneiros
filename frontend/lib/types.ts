export interface BoundingBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FieldComparison {
  key: string;
  label: string;
  referenceValue: string | null;
  producedValue: string | null;
  match: boolean;
  referenceBoundingBox: BoundingBox | null;
  producedBoundingBox: BoundingBox | null;
}

export interface PageImage {
  page: number;
  dataUrl: string;
  width: number;
  height: number;
}

export interface CompareResponse {
  overallMatch: boolean;
  fields: FieldComparison[];
  referencePages: PageImage[];
  producedPages: PageImage[];
}

export interface OcrWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RasterizedPage {
  png: Buffer;
  width: number;
  height: number;
}

export type FieldKey =
  | "cnpj"
  | "razaoSocial"
  | "endereco"
  | "pesoBruto"
  | "pesoLiquido"
  | "valorTotal";

export const FIELDS: { key: FieldKey; label: string }[] = [
  { key: "cnpj", label: "CNPJ" },
  { key: "razaoSocial", label: "Razão Social" },
  { key: "endereco", label: "Endereço" },
  { key: "pesoBruto", label: "Peso Bruto" },
  { key: "pesoLiquido", label: "Peso Líquido" },
  { key: "valorTotal", label: "Valor Total" },
];

export type ExtractedEntities = Record<FieldKey, string | null>;
