"""Smoke test for the /compare pipeline end-to-end.

Runs the real rasterization + OCR + normalization + bbox-localization code
against two synthetic documents, with extract_entities() mocked (so it never
calls the Anthropic API). Mirrors the approach described in
backend_architecture.md section 6.
"""

import io
import os
from unittest.mock import patch

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-test-placeholder")

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageFont

import backend_main


FONT_PATH = r"C:\Windows\Fonts\arial.ttf" if os.name == "nt" else None


def _font(size: int) -> ImageFont.FreeTypeFont:
    if FONT_PATH and os.path.exists(FONT_PATH):
        return ImageFont.truetype(FONT_PATH, size)
    return ImageFont.load_default()


def make_document(lines: list[str]) -> Image.Image:
    image = Image.new("RGB", (1000, 1200), "white")
    draw = ImageDraw.Draw(image)
    font = _font(28)
    y = 60
    for line in lines:
        draw.text((60, y), line, fill="black", font=font)
        y += 60
    return image


def to_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


REFERENCE_LINES = [
    "INVOICE NO 2026-0417",
    "CNPJ: 12.345.678/0001-90",
    "Razao Social: ACME EXPORTACOES LTDA",
    "Endereco: Rua das Flores 123 Sao Paulo SP",
    "Peso Bruto: 1250,500 KG   Peso Liquido: 1190,000 KG",
    "Valor Total: R$ 45320,00",
]

PRODUCED_LINES = [
    "CERTIFICADO DE ORIGEM",
    "CNPJ: 12.345.678/0001-90",
    "Razao Social: Acme Exportacoes Ltda.",
    "Endereco: Rua das Flores 123 Sao Paulo SP",
    "Peso Bruto: 1250.5 KG   Peso Liquido: 1150,000 KG",
    "Valor Total: USD 45320.00",
]

MOCK_REFERENCE_ENTITIES = {
    "cnpj": "12.345.678/0001-90",
    "razaoSocial": "ACME EXPORTACOES LTDA",
    "endereco": "Rua das Flores 123 Sao Paulo SP",
    "pesoBruto": "1250,500 KG",
    "pesoLiquido": "1190,000 KG",
    "valorTotal": "R$ 45320,00",
}

MOCK_PRODUCED_ENTITIES = {
    "cnpj": "12.345.678/0001-90",
    "razaoSocial": "Acme Exportacoes Ltda.",
    "endereco": "Rua das Flores 123 Sao Paulo SP",
    "pesoBruto": "1250.5 KG",
    "pesoLiquido": "1150,000 KG",
    "valorTotal": "USD 45320.00",
}


def fake_extract_entities(image: Image.Image) -> dict:
    pixels = image.load()
    # Distinguish the two synthetic documents by a marker pixel painted below.
    marker = pixels[5, 5]
    return MOCK_REFERENCE_ENTITIES if marker == (10, 10, 10) else MOCK_PRODUCED_ENTITIES


def run():
    reference_image = make_document(REFERENCE_LINES)
    reference_image.putpixel((5, 5), (10, 10, 10))

    produced_image = make_document(PRODUCED_LINES)
    produced_image.putpixel((5, 5), (20, 20, 20))

    client = TestClient(backend_main.app)

    with patch.object(backend_main, "extract_entities", side_effect=fake_extract_entities):
        response = client.post(
            "/compare",
            files={
                "reference_files": ("invoice.png", to_bytes(reference_image), "image/png"),
                "produced_file": ("certificado.png", to_bytes(produced_image), "image/png"),
            },
        )

    assert response.status_code == 200, response.text
    data = response.json()

    fields_by_key = {f["key"]: f for f in data["fields"]}

    assert fields_by_key["cnpj"]["match"] is True
    assert fields_by_key["razaoSocial"]["match"] is True, fields_by_key["razaoSocial"]
    assert fields_by_key["endereco"]["match"] is True, fields_by_key["endereco"]
    assert fields_by_key["pesoBruto"]["match"] is True, fields_by_key["pesoBruto"]
    assert fields_by_key["pesoLiquido"]["match"] is False, fields_by_key["pesoLiquido"]
    assert fields_by_key["valorTotal"]["match"] is False, fields_by_key["valorTotal"]
    assert data["overallMatch"] is False

    # Bounding boxes for Peso Bruto / Peso Liquido must not collide even
    # though both are on the same line (regression check for the window-size bug).
    bruto_box = fields_by_key["pesoBruto"]["referenceBoundingBox"]
    liquido_box = fields_by_key["pesoLiquido"]["referenceBoundingBox"]
    assert bruto_box is not None and liquido_box is not None
    bruto_right_edge = bruto_box["x"] + bruto_box["width"]
    assert bruto_right_edge <= liquido_box["x"] + 0.01, (bruto_box, liquido_box)

    print("OK — all assertions passed.")
    print("overallMatch:", data["overallMatch"])
    for key, field in fields_by_key.items():
        print(f"  {key}: match={field['match']} ref={field['referenceValue']!r} prod={field['producedValue']!r}")


if __name__ == "__main__":
    run()
