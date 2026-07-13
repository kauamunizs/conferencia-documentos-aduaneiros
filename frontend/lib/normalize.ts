import type { FieldKey } from "./types";

export function normalizeCnpj(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length === 14 ? digits : digits || null;
}

const COMBINING_MARKS_RE = /[̀-ͯ]/g;

function stripAccents(value: string): string {
  return value.normalize("NFKD").replace(COMBINING_MARKS_RE, "");
}

export function normalizeText(value: string | null): string | null {
  if (!value) return null;
  let text = stripAccents(value).toUpperCase();
  text = text.replace(/\bLTDA\.?\b/g, "LTDA");
  text = text.replace(/\bS\.?A\.?\b/g, "SA");
  text = text.replace(/[.,;:]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text || null;
}

function parseNumber(raw: string, maxDecimalDigits = 2): number | null {
  raw = raw.trim();
  if (!raw) return null;
  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");

  if (hasComma && hasDot) {
    if (raw.lastIndexOf(",") > raw.lastIndexOf(".")) {
      raw = raw.replaceAll(".", "").replace(",", ".");
    } else {
      raw = raw.replaceAll(",", "");
    }
  } else if (hasComma) {
    // comma as decimal separator only if followed by 1..N digits at the end
    if (new RegExp(`,\\d{1,${maxDecimalDigits}}$`).test(raw)) {
      raw = raw.replace(",", ".");
    } else {
      raw = raw.replaceAll(",", "");
    }
  } else if (hasDot) {
    // dot as decimal separator only if followed by 1..N digits at the end;
    // otherwise treat as a thousands separator (e.g. "1.250" meaning 1250)
    if (!new RegExp(`\\.\\d{1,${maxDecimalDigits}}$`).test(raw)) {
      raw = raw.replaceAll(".", "");
    }
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

const WEIGHT_UNIT_TO_KG: Record<string, number> = {
  KG: 1,
  KGS: 1,
  G: 0.001,
  GR: 0.001,
  LB: 0.453592,
  LBS: 0.453592,
  TON: 1000,
  T: 1000,
};

export function normalizeWeight(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/([\d.,]+)\s*([A-Za-zÀ-ÿ]*)/);
  if (!match) return null;
  const number = parseNumber(match[1], 3);
  if (number === null) return null;
  const unit = match[2].toUpperCase() || "KG";
  const factor = WEIGHT_UNIT_TO_KG[unit] ?? 1;
  return Math.round(number * factor * 1000) / 1000;
}

const CURRENCY_ALIASES: [string, string][] = [
  ["R$", "BRL"],
  ["US$", "USD"],
  ["$", "USD"],
  ["USD", "USD"],
  ["BRL", "BRL"],
  ["EUR", "EUR"],
  ["€", "EUR"],
];

export function normalizeCurrency(value: string | null): { amount: number; currency: string | null } | null {
  if (!value) return null;
  let currency: string | null = null;
  const upper = value.toUpperCase();
  for (const [symbol, code] of CURRENCY_ALIASES) {
    if (upper.includes(symbol)) {
      currency = code;
      break;
    }
  }
  const numberPart = value.replace(/[A-Za-zÀ-ÿ$€\s]/g, "");
  const number = parseNumber(numberPart, 2);
  if (number === null) return null;
  return { amount: Math.round(number * 100) / 100, currency };
}

export function valuesMatch(key: FieldKey, referenceRaw: string | null, producedRaw: string | null): boolean {
  if (referenceRaw === null || producedRaw === null) return false;

  if (key === "cnpj") {
    return normalizeCnpj(referenceRaw) === normalizeCnpj(producedRaw);
  }
  if (key === "razaoSocial" || key === "endereco") {
    return normalizeText(referenceRaw) === normalizeText(producedRaw);
  }
  if (key === "pesoBruto" || key === "pesoLiquido") {
    const a = normalizeWeight(referenceRaw);
    const b = normalizeWeight(producedRaw);
    return a !== null && b !== null && Math.abs(a - b) < 0.001;
  }
  if (key === "valorTotal") {
    const a = normalizeCurrency(referenceRaw);
    const b = normalizeCurrency(producedRaw);
    if (a === null || b === null) return false;
    const amountsMatch = Math.abs(a.amount - b.amount) < 0.005;
    const currenciesMatch = a.currency === null || b.currency === null || a.currency === b.currency;
    return amountsMatch && currenciesMatch;
  }
  return normalizeText(referenceRaw) === normalizeText(producedRaw);
}
