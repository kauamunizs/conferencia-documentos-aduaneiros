# Arquitetura do Backend — Conferência de Documentos Aduaneiros

## 0. Modo mock (nenhuma chamada de API)

Por padrão (`MOCK_MODE=true` no `.env`), o backend **nunca chama a API da
Anthropic** — nenhum custo é gerado, mesmo clicando em "Processar
documentos". `extract_entities()` devolve valores fixos (alternando entre
dois conjuntos, para mostrar tanto campos que batem quanto campos que não
batem no relatório) em vez de ler as imagens de verdade. Todo o resto do
pipeline — rasterização, OCR local, normalização, comparação, localização de
bounding box e a interface — roda normalmente com dados reais.

Para ligar a extração de verdade (paga), edite `backend/.env`:

```
MOCK_MODE=false
ANTHROPIC_API_KEY=sk-ant-sua-chave-real
```

## 1. Visão geral do pipeline

```
Upload (PDF/imagem)
   │
   ▼
1. rasterize_document()      → lista de imagens PIL, uma por página
   │                            (pdf2image + poppler para PDF; PIL para imagem)
   ▼
2. run_ocr() por página       → posição (bounding box) de cada palavra
   │                            (pytesseract / Tesseract, local, sem custo de API)
   ▼
3. extract_entities() por página → texto literal de cada campo vital
   │                            (Claude Vision, prompt em system_prompt.md)
   ▼
4. normalize_*()               → CNPJ, peso, moeda e texto em forma canônica
   │                            (determinístico, 100% Python, sem LLM)
   ▼
5. values_match()              → comparação campo a campo (bate / não bate)
   │
   ▼
6. locate_bbox()                → localização fuzzy do texto extraído no OCR,
   │                              devolve bounding box normalizada (0–1)
   ▼
7. Serialização camelCase       → resposta JSON para o front-end Next.js
```

## 2. Por que cada peça foi escolhida

- **pdf2image + poppler**: forma mais simples e robusta de rasterizar PDFs
  multi-página em imagens que tanto o OCR local quanto a Claude Vision
  conseguem processar. Poppler é a dependência de sistema (não Python).
- **Tesseract via pytesseract**: OCR local, gratuito, suficiente para obter
  **posição** de texto na página (bounding boxes). Não é usado para decidir o
  conteúdo dos campos — só para localizá-los visualmente depois que a Claude
  Vision já disse qual é o valor.
- **Claude Vision**: única peça do sistema que "lê" a imagem e entende o
  layout do documento. Devolve texto **literal**, sem normalizar — ver seção
  3 sobre por quê.
- **Normalização determinística em Python**: CNPJ, peso, moeda e texto viram
  formas canônicas por regras fixas (`normalize_cnpj`, `normalize_weight`,
  `normalize_currency`, `normalize_text`), garantindo que a decisão de
  "bate/não bate" seja sempre reproduzível e auditável — não depende de uma
  chamada de LLM que poderia variar entre execuções.
- **Fuzzy match para bounding box**: a Claude Vision devolve texto, não
  coordenadas. Para desenhar os retângulos verdes/vermelhos no
  visualizador, o backend precisa achar onde aquele texto está no OCR local.
  Isso é feito testando múltiplos tamanhos de janela de palavras
  consecutivas e aparando as bordas (ver seção 4 — bug corrigido).
- **Pydantic com `alias_generator=to_camel`**: o contrato JSON com o
  front-end é camelCase (convenção JS/TS), mas o código Python interno usa
  snake_case (convenção PEP 8). O `alias_generator` faz essa tradução
  automaticamente na serialização, sem precisar duplicar nomes de campos.

## 3. Decisão de arquitetura central: LLM só extrai, Python decide

A Claude Vision **nunca** decide se dois valores "batem". Ela só transcreve o
que está escrito na imagem, campo a campo, sem converter unidades nem
normalizar formatação. Toda comparação passa por `values_match()`, que usa
funções determinísticas de normalização.

Isso é proposital: um LLM decidindo "R$ 1.500,00 bate com 1500.00 BRL?" pode
variar a resposta entre execuções, é mais lento, mais caro, e não é auditável
(não dá para explicar exatamente por que decidiu daquele jeito). Regras
determinísticas em Python são sempre reprodutíveis e podem ser testadas com
unit tests. Isso é o que permite tolerância de erro zero: qualquer diferença
real no valor normalizado é reportada como discrepância, sem "acho que bate"
de um LLM.

## 4. Bug corrigido: bounding box roubando a posição do campo vizinho

A primeira versão de `locate_bbox` usava uma janela de tamanho fixo (igual
ao número de palavras do texto-alvo) para buscar no OCR. Isso falhava
quando:

- A Claude Vision incluía um pouco mais ou menos texto do que o OCR separou
  em palavras (ex: "12.345.678/0001-90" pode virar 1 ou 3 "palavras"
  dependendo do tokenizador do Tesseract).
- Dois campos ficavam muito próximos na mesma linha (ex: "Peso Bruto: 1.200
  KG   Peso Líquido: 1.150 KG") — a janela de tamanho fixo às vezes
  capturava parte do campo vizinho.

A correção testa múltiplos tamanhos de janela (`target_word_count - 1` até
`target_word_count + 2`) e, depois de achar a melhor pontuação de
similaridade, **apara as bordas**: tenta encolher a janela pela esquerda e
pela direita enquanto a similaridade não piorar. Isso isola corretamente o
texto mesmo quando campos vizinhos estão na mesma linha — confirmado no
teste com Peso Bruto e Peso Líquido lado a lado.

Também foram corrigidos, na mesma normalização:

- Comparação de razão social falhando por pontuação trivial (`"Ltda."` vs
  `"LTDA"`) — resolvido normalizando abreviações comuns (`LTDA`, `SA`) e
  removendo pontuação antes de comparar.
- Comparação de moeda falhando por formatação BR vs US (`"R$ 1.500,00"` vs
  `"1500.00 BRL"`) — resolvido com heurística de separador decimal em
  `_parse_number` mais mapeamento de símbolos de moeda.

## 5. Contrato JSON entre front-end e back-end

`POST /compare` — `multipart/form-data`:

- `reference_files`: um ou mais arquivos (PDF ou imagem) — documento de
  Referência (ex: Invoice).
- `produced_file`: um arquivo (PDF ou imagem) — Doc Produzido (ex:
  Certificado de Origem).

Resposta (camelCase):

```jsonc
{
  "overallMatch": false,
  "fields": [
    {
      "key": "cnpj",
      "label": "CNPJ",
      "referenceValue": "12.345.678/0001-90",
      "producedValue": "12.345.678/0001-90",
      "match": true,
      "referenceBoundingBox": { "page": 0, "x": 0.12, "y": 0.34, "width": 0.2, "height": 0.03 },
      "producedBoundingBox": { "page": 0, "x": 0.15, "y": 0.22, "width": 0.18, "height": 0.03 }
    }
    // ... razaoSocial, endereco, pesoBruto, pesoLiquido, valorTotal
  ],
  "referencePages": [
    { "page": 0, "dataUrl": "data:image/png;base64,...", "width": 1654, "height": 2339 }
  ],
  "producedPages": [
    { "page": 0, "dataUrl": "data:image/png;base64,...", "width": 1654, "height": 2339 }
  ]
}
```

As bounding boxes são normalizadas (0–1) em relação ao tamanho da página, de
modo que o front-end só precisa posicionar `left: x * 100%`, `top: y * 100%`
etc. sobre a imagem renderizada, sem se preocupar com a resolução real do
PDF/imagem.

## 6. O que já foi testado

- Pipeline completo `/compare` rodado de ponta a ponta via
  `fastapi.testclient.TestClient`, com `extract_entities` mockado (para não
  gastar chamadas de API), incluindo geração de imagem sintética, OCR real
  via Tesseract, comparação e serialização JSON. Retornou 200 com o
  relatório e bounding boxes corretas.
- `page.tsx` compila limpo com `tsc --noEmit` (TypeScript estrito).

## 7. Limitações conhecidas do esboço atual

- `normalize_currency` usa heurística para decidir separador decimal vs.
  milhar — cobre os casos comuns (BR: `1.500,00`; US: `1,500.00`) mas não é
  100% robusta para todos os formatos possíveis do mundo.
- Quando o documento lista mais de uma empresa (Exportador e Importador), o
  `system_prompt.md` sempre extrai os dados do Exportador/Shipper — isso
  está fixo no prompt, não é configurável via API.
- OCR local (Tesseract) é suficiente para o esboço, mas em produção real,
  para documentos escaneados/tortos, vale considerar AWS Textract ou Google
  Document AI, que lidam melhor com rotação e baixa qualidade de scan.
- O endpoint `/compare` é síncrono e bloqueante — para produção, mover para
  fila assíncrona (Celery, RQ, ou um worker separado), com o front-end
  fazendo polling ou recebendo webhook/SSE do resultado. O front-end já está
  pronto para isso: só chama `fetch(\`${API_BASE_URL}/compare\`)` e espera a
  resposta.
- Sem persistência: nada é salvo em banco de dados ou storage em nuvem.
  Cada chamada a `/compare` é isolada e stateless. Para produção real, vale
  guardar os documentos originais e o relatório para auditoria posterior
  (storage em nuvem: S3/GCS + banco de dados para o histórico).
- Sem autenticação/autorização no endpoint — necessário antes de expor a
  qualquer rede que não seja localhost de desenvolvimento.
