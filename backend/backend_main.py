import base64
import difflib
import io
import json
import os
import re
import unicodedata
from pathlib import Path
from typing import List, Optional, Tuple

import anthropic
import pytesseract
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pdf2image import convert_from_bytes
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

load_dotenv()

MODEL = "claude-opus-4-8"
SYSTEM_PROMPT = Path(__file__).with_name("system_prompt.md").read_text(encoding="utf-8")

# Optional local overrides for the Tesseract/Poppler binaries and language data.
# Only needed on machines where these aren't already resolvable via PATH
# (e.g. Windows installs that don't register themselves on PATH). TESSDATA_PREFIX,
# if set, is read directly by the tesseract executable via the inherited environment.
if os.environ.get("TESSERACT_CMD"):
    pytesseract.pytesseract.tesseract_cmd = os.environ["TESSERACT_CMD"]
POPPLER_PATH = os.environ.get("POPPLER_PATH") or None

# Dev-only: MOCK_MODE=true skips the paid Claude Vision call and returns
# canned field values instead, so the full upload -> compare -> report flow
# can be exercised through the real frontend without spending API credits.
# Never enable this in production — it doesn't read the actual documents.
MOCK_MODE = os.environ.get("MOCK_MODE", "false").strip().lower() == "true"

FIELDS = [
    ("cnpj", "CNPJ"),
    ("razaoSocial", "Razão Social"),
    ("endereco", "Endereço"),
    ("pesoBruto", "Peso Bruto"),
    ("pesoLiquido", "Peso Líquido"),
    ("valorTotal", "Valor Total"),
]

anthropic_client = None if MOCK_MODE else anthropic.Anthropic()

app = FastAPI(title="Conferência de Documentos Aduaneiros")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("FRONTEND_ORIGIN", "http://localhost:3000")],
    allow_methods=["*"],
    allow_headers=["*"],
)


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class BoundingBox(CamelModel):
    page: int
    x: float
    y: float
    width: float
    height: float


class FieldComparison(CamelModel):
    key: str
    label: str
    reference_value: Optional[str]
    produced_value: Optional[str]
    match: bool
    reference_bounding_box: Optional[BoundingBox]
    produced_bounding_box: Optional[BoundingBox]


class PageImage(CamelModel):
    page: int
    data_url: str
    width: int
    height: int


class CompareResponse(CamelModel):
    overall_match: bool
    fields: List[FieldComparison]
    reference_pages: List[PageImage]
    produced_pages: List[PageImage]


# ---------------------------------------------------------------------------
# Rasterization
# ---------------------------------------------------------------------------

def rasterize_document(filename: str, content: bytes) -> List[Image.Image]:
    if filename.lower().endswith(".pdf"):
        pages = convert_from_bytes(content, dpi=200, poppler_path=POPPLER_PATH)
        return [page.convert("RGB") for page in pages]
    return [Image.open(io.BytesIO(content)).convert("RGB")]


def image_to_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def image_to_base64_jpeg(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=85)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


# ---------------------------------------------------------------------------
# OCR (local positioning)
# ---------------------------------------------------------------------------

class OcrWord:
    __slots__ = ("text", "left", "top", "width", "height")

    def __init__(self, text: str, left: int, top: int, width: int, height: int):
        self.text = text
        self.left = left
        self.top = top
        self.width = width
        self.height = height


def run_ocr(image: Image.Image) -> List[OcrWord]:
    data = pytesseract.image_to_data(image, lang="por+eng", output_type=pytesseract.Output.DICT)
    words: List[OcrWord] = []
    for i, text in enumerate(data["text"]):
        text = text.strip()
        if not text:
            continue
        try:
            conf = float(data["conf"][i])
        except (ValueError, TypeError):
            conf = -1.0
        if conf < 0:
            continue
        words.append(
            OcrWord(
                text=text,
                left=int(data["left"][i]),
                top=int(data["top"][i]),
                width=int(data["width"][i]),
                height=int(data["height"][i]),
            )
        )
    return words


# ---------------------------------------------------------------------------
# Claude Vision extraction (literal transcription only — no normalization)
# ---------------------------------------------------------------------------

# Canned values used only when MOCK_MODE=true, so the app can be clicked
# through end-to-end without ever calling the Anthropic API. They alternate
# per call so the report shows a realistic mix of matches/mismatches — they
# do NOT reflect what's actually written on the uploaded documents.
_MOCK_ENTITIES = [
    {
        "cnpj": "12.345.678/0001-90",
        "razaoSocial": "EMPRESA EXEMPLO LTDA",
        "endereco": "Rua Exemplo, 100 - Sao Paulo - SP",
        "pesoBruto": "1.000,000 KG",
        "pesoLiquido": "950,000 KG",
        "valorTotal": "R$ 10.000,00",
    },
    {
        "cnpj": "12.345.678/0001-90",
        "razaoSocial": "Empresa Exemplo Ltda.",
        "endereco": "Rua Exemplo, 100 - Sao Paulo/SP",
        "pesoBruto": "1000.0 KG",
        "pesoLiquido": "900,000 KG",
        "valorTotal": "USD 10000.00",
    },
]
_mock_call_count = 0


def extract_entities(image: Image.Image) -> dict:
    if MOCK_MODE:
        global _mock_call_count
        entities = _MOCK_ENTITIES[_mock_call_count % len(_MOCK_ENTITIES)]
        _mock_call_count += 1
        return dict(entities)

    response = anthropic_client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": image_to_base64_jpeg(image),
                        },
                    },
                    {"type": "text", "text": "Extraia os campos desta página conforme instruído."},
                ],
            }
        ],
    )
    text = next((block.text for block in response.content if block.type == "text"), "{}")
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {key: None for key, _ in FIELDS}
    return {key: parsed.get(key) for key, _ in FIELDS}


# ---------------------------------------------------------------------------
# Deterministic normalization
# ---------------------------------------------------------------------------

def normalize_cnpj(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    digits = re.sub(r"\D", "", value)
    return digits if len(digits) == 14 else (digits or None)


def strip_accents(value: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", value) if not unicodedata.combining(c))


def normalize_text(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    text = strip_accents(value).upper()
    text = re.sub(r"\bLTDA\.?\b", "LTDA", text)
    text = re.sub(r"\bS\.?A\.?\b", "SA", text)
    text = re.sub(r"[.,;:]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def _parse_number(raw: str, max_decimal_digits: int = 2) -> Optional[float]:
    raw = raw.strip()
    if not raw:
        return None
    has_comma = "," in raw
    has_dot = "." in raw
    if has_comma and has_dot:
        if raw.rfind(",") > raw.rfind("."):
            raw = raw.replace(".", "").replace(",", ".")
        else:
            raw = raw.replace(",", "")
    elif has_comma:
        # comma as decimal separator only if followed by 1..N digits at the end
        if re.search(rf",\d{{1,{max_decimal_digits}}}$", raw):
            raw = raw.replace(",", ".")
        else:
            raw = raw.replace(",", "")
    elif has_dot:
        # dot as decimal separator only if followed by 1..N digits at the end;
        # otherwise treat as a thousands separator (e.g. "1.250" meaning 1250)
        if not re.search(rf"\.\d{{1,{max_decimal_digits}}}$", raw):
            raw = raw.replace(".", "")
    try:
        return float(raw)
    except ValueError:
        return None


WEIGHT_UNIT_TO_KG = {
    "KG": 1.0,
    "KGS": 1.0,
    "G": 0.001,
    "GR": 0.001,
    "LB": 0.453592,
    "LBS": 0.453592,
    "TON": 1000.0,
    "T": 1000.0,
}


def normalize_weight(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    match = re.search(r"([\d.,]+)\s*([A-Za-zÀ-ÿ]*)", value)
    if not match:
        return None
    number = _parse_number(match.group(1), max_decimal_digits=3)
    if number is None:
        return None
    unit = match.group(2).upper() or "KG"
    factor = WEIGHT_UNIT_TO_KG.get(unit, 1.0)
    return round(number * factor, 3)


CURRENCY_ALIASES = {
    "R$": "BRL",
    "US$": "USD",
    "$": "USD",
    "USD": "USD",
    "BRL": "BRL",
    "EUR": "EUR",
    "€": "EUR",
}


def normalize_currency(value: Optional[str]) -> Optional[Tuple[float, Optional[str]]]:
    if not value:
        return None
    currency = None
    for symbol, code in CURRENCY_ALIASES.items():
        if symbol in value.upper():
            currency = code
            break
    number_part = re.sub(r"[A-Za-zÀ-ÿ$€\s]", "", value)
    number = _parse_number(number_part)
    if number is None:
        return None
    return round(number, 2), currency


def values_match(key: str, reference_raw: Optional[str], produced_raw: Optional[str]) -> bool:
    if reference_raw is None or produced_raw is None:
        return False
    if key == "cnpj":
        return normalize_cnpj(reference_raw) == normalize_cnpj(produced_raw)
    if key in ("razaoSocial", "endereco"):
        return normalize_text(reference_raw) == normalize_text(produced_raw)
    if key in ("pesoBruto", "pesoLiquido"):
        a, b = normalize_weight(reference_raw), normalize_weight(produced_raw)
        return a is not None and b is not None and abs(a - b) < 0.001
    if key == "valorTotal":
        a, b = normalize_currency(reference_raw), normalize_currency(produced_raw)
        if a is None or b is None:
            return False
        amounts_match = abs(a[0] - b[0]) < 0.005
        currencies_match = a[1] is None or b[1] is None or a[1] == b[1]
        return amounts_match and currencies_match
    return normalize_text(reference_raw) == normalize_text(produced_raw)


# ---------------------------------------------------------------------------
# Bounding box localization via fuzzy match against OCR words
# ---------------------------------------------------------------------------

def _window_similarity(words: List[OcrWord], start: int, end: int, target_norm: str) -> float:
    window_text = normalize_text(" ".join(w.text for w in words[start:end])) or ""
    return difflib.SequenceMatcher(None, window_text, target_norm).ratio()


def locate_bbox(words: List[OcrWord], target_text: Optional[str], page: int, image_size: Tuple[int, int]) -> Optional[BoundingBox]:
    if not target_text or not words:
        return None
    target_norm = normalize_text(target_text) or ""
    if not target_norm:
        return None
    target_word_count = max(1, len(target_norm.split()))

    best_score = -1.0
    best_start, best_end = 0, 0
    candidate_sizes = sorted({target_word_count, target_word_count + 1, target_word_count + 2, max(1, target_word_count - 1)})
    for size in candidate_sizes:
        if size <= 0 or size > len(words):
            continue
        for start in range(0, len(words) - size + 1):
            end = start + size
            score = _window_similarity(words, start, end, target_norm)
            if score > best_score:
                best_score, best_start, best_end = score, start, end

    if best_score < 0.4:
        return None

    # Trim edges: shrink the window while similarity doesn't drop.
    while best_end - best_start > 1:
        trimmed_left = _window_similarity(words, best_start + 1, best_end, target_norm)
        trimmed_right = _window_similarity(words, best_start, best_end - 1, target_norm)
        if trimmed_left >= best_score:
            best_start += 1
            best_score = trimmed_left
        elif trimmed_right >= best_score:
            best_end -= 1
            best_score = trimmed_right
        else:
            break

    window = words[best_start:best_end]
    left = min(w.left for w in window)
    top = min(w.top for w in window)
    right = max(w.left + w.width for w in window)
    bottom = max(w.top + w.height for w in window)
    img_w, img_h = image_size
    return BoundingBox(
        page=page,
        x=left / img_w,
        y=top / img_h,
        width=(right - left) / img_w,
        height=(bottom - top) / img_h,
    )


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

class DocumentPages:
    def __init__(self):
        self.images: List[Image.Image] = []
        self.ocr: List[List[OcrWord]] = []
        self.entities: dict = {key: None for key, _ in FIELDS}
        self.entity_page: dict = {}

    def add_page(self, image: Image.Image):
        self.images.append(image)
        self.ocr.append(run_ocr(image))

    def extract(self):
        for page_index, image in enumerate(self.images):
            page_entities = extract_entities(image)
            for key, _ in FIELDS:
                if self.entities.get(key) is None and page_entities.get(key):
                    self.entities[key] = page_entities[key]
                    self.entity_page[key] = page_index


def process_upload(filename: str, content: bytes, doc: DocumentPages):
    for image in rasterize_document(filename, content):
        doc.add_page(image)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/compare", response_model=CompareResponse)
async def compare(
    reference_files: List[UploadFile] = File(...),
    produced_file: UploadFile = File(...),
):
    reference_doc = DocumentPages()
    for upload in reference_files:
        content = await upload.read()
        process_upload(upload.filename or "reference", content, reference_doc)
    if not reference_doc.images:
        raise HTTPException(400, "Nenhuma página válida encontrada nos documentos de referência.")

    produced_doc = DocumentPages()
    produced_content = await produced_file.read()
    process_upload(produced_file.filename or "produced", produced_content, produced_doc)
    if not produced_doc.images:
        raise HTTPException(400, "Nenhuma página válida encontrada no documento produzido.")

    try:
        reference_doc.extract()
        produced_doc.extract()
    except anthropic.AuthenticationError as exc:
        raise HTTPException(502, "Chave da API Anthropic inválida ou ausente (ANTHROPIC_API_KEY).") from exc
    except anthropic.APIError as exc:
        raise HTTPException(502, f"Erro ao chamar a Claude Vision: {exc.message}") from exc

    fields: List[FieldComparison] = []
    overall_match = True
    for key, label in FIELDS:
        ref_value = reference_doc.entities.get(key)
        prod_value = produced_doc.entities.get(key)
        match = values_match(key, ref_value, prod_value)
        overall_match = overall_match and match

        ref_bbox = None
        if key in reference_doc.entity_page:
            page = reference_doc.entity_page[key]
            ref_bbox = locate_bbox(reference_doc.ocr[page], ref_value, page, reference_doc.images[page].size)

        prod_bbox = None
        if key in produced_doc.entity_page:
            page = produced_doc.entity_page[key]
            prod_bbox = locate_bbox(produced_doc.ocr[page], prod_value, page, produced_doc.images[page].size)

        fields.append(
            FieldComparison(
                key=key,
                label=label,
                reference_value=ref_value,
                produced_value=prod_value,
                match=match,
                reference_bounding_box=ref_bbox,
                produced_bounding_box=prod_bbox,
            )
        )

    reference_pages = [
        PageImage(page=i, data_url=image_to_data_url(img), width=img.width, height=img.height)
        for i, img in enumerate(reference_doc.images)
    ]
    produced_pages = [
        PageImage(page=i, data_url=image_to_data_url(img), width=img.width, height=img.height)
        for i, img in enumerate(produced_doc.images)
    ]

    return CompareResponse(
        overall_match=overall_match,
        fields=fields,
        reference_pages=reference_pages,
        produced_pages=produced_pages,
    )
