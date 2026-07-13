# Arquitetura — Conferência de Documentos Aduaneiros (Node/Next.js)

Projeto 100% Node.js: front-end e back-end vivem no mesmo app Next.js
(`frontend/`), pronto para deploy na Vercel. Não há mais um serviço Python
separado — a versão FastAPI/Tesseract/Poppler original foi portada
integralmente para TypeScript.

## 0. Modo mock (nenhuma chamada de API)

Por padrão (`MOCK_MODE=true`), o app **nunca chama a API da Anthropic** —
zero custo, mesmo clicando em "Processar documentos". `extractEntities()`
devolve valores fixos (alternando entre dois conjuntos, para mostrar tanto
campos que batem quanto campos que não batem) em vez de ler as imagens de
verdade. Todo o resto do pipeline — rasterização, OCR local, normalização,
comparação, localização de bounding box e a interface — roda normalmente
com dados reais.

Para ligar a extração de verdade (paga), configure na Vercel (ou no
`.env.local`):

```
MOCK_MODE=false
ANTHROPIC_API_KEY=sk-ant-sua-chave-real
```

## 1. Visão geral do pipeline

```
Upload (PDF/imagem) — multipart/form-data em POST /api/compare
   │
   ▼
1. rasterizeDocument()      → páginas em PNG (Buffer)
   │                           PDF: pdfjs-dist + @napi-rs/canvas (sem binário do sistema)
   │                           imagem: sharp
   ▼
2. runOcr() por página        → posição (bounding box) de cada palavra
   │                            (tesseract.js — OCR em WASM, sem Tesseract instalado no SO)
   ▼
3. extractEntities() por página → texto literal de cada campo vital
   │                            (Claude Vision via @anthropic-ai/sdk, ou mock — ver seção 0)
   ▼
4. normalize*()                → CNPJ, peso, moeda e texto em forma canônica
   │                            (determinístico, lib/normalize.ts, sem LLM)
   ▼
5. valuesMatch()                → comparação campo a campo (bate / não bate)
   │
   ▼
6. locateBbox()                  → localização fuzzy do texto extraído no OCR,
   │                              devolve bounding box normalizada (0–1)
   ▼
7. NextResponse.json(...)        → resposta para o componente React (mesma origem)
```

## 2. Por que cada peça foi escolhida (e por que é serverless-friendly)

- **pdfjs-dist + `@napi-rs/canvas`**: pdfjs-dist detecta Node automaticamente
  e usa `@napi-rs/canvas` internamente (`NodeCanvasFactory`) — sem precisar
  do Poppler/`pdftoppm` instalado no sistema. `@napi-rs/canvas` traz
  binários pré-compilados (napi), então não exige compilador C++ no
  ambiente de build da Vercel.
- **tesseract.js**: OCR local rodando em WASM — não depende do binário
  `tesseract` do sistema operacional, o que o torna compatível com funções
  serverless da Vercel. Os dados de idioma (`por`/`eng`) são baixados de um
  CDN na primeira execução de cada instância fria.
- **sharp**: manipulação de imagem (conversão PNG/JPEG, leitura de
  metadados). É uma das dependências que a própria Next.js já trata como
  "external package" nativamente.
- **Claude Vision (`@anthropic-ai/sdk`)**: única peça do sistema que "lê" a
  imagem e entende o layout do documento. Devolve texto **literal**, sem
  normalizar — ver seção 3 sobre por quê.
- **Normalização determinística em TypeScript**: `lib/normalize.ts` é o
  port direto do `normalize_cnpj`/`normalize_weight`/`normalize_currency`/
  `normalize_text` que existiam em Python, incluindo as mesmas correções de
  bug (heurística de separador decimal com até 3 casas para peso, 2 para
  moeda; abreviações `LTDA`/`SA`).
- **`app.next.config.ts` → `serverExternalPackages`**: `@napi-rs/canvas`,
  `pdfjs-dist` e `tesseract.js` carregam binários nativos/WASM que o
  Turbopack não consegue colocar num chunk ESM — por isso ficam marcados
  como pacotes externos, carregados via `require()`/`import()` dinâmico em
  tempo de execução em vez de bundlados estaticamente.

## 3. Decisão de arquitetura central: LLM só extrai, o código decide

Igual à versão Python original: a Claude Vision **nunca** decide se dois
valores "batem". Ela só transcreve o que está escrito na imagem, campo a
campo, sem converter unidades nem normalizar formatação. Toda comparação
passa por `valuesMatch()` (`lib/normalize.ts`), que usa funções
determinísticas de normalização — reprodutíveis, testáveis, e sem depender
de uma chamada de LLM para decidir "R$ 1.500,00 bate com 1500.00 BRL?".

## 4. Contrato JSON (`POST /api/compare`)

`multipart/form-data`:

- `reference_files`: um ou mais arquivos (PDF ou imagem) — Referência.
- `produced_file`: um arquivo (PDF ou imagem) — Doc Produzido.

Resposta (camelCase — ver `lib/types.ts`, usado tanto pela API route quanto
pelo componente React, então front e back nunca dessincronizam):

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
  ],
  "referencePages": [{ "page": 0, "dataUrl": "data:image/png;base64,...", "width": 1654, "height": 2339 }],
  "producedPages": [{ "page": 0, "dataUrl": "data:image/png;base64,...", "width": 1654, "height": 2339 }]
}
```

## 5. O que já foi testado localmente

- `tsc --noEmit` limpo (TypeScript estrito).
- `next build` (produção, Turbopack) passa sem erros.
- `next start` (servidor de produção compilado) testado de ponta a ponta
  com upload real de imagem — relatório e bounding boxes corretos.
- Rasterização de **PDF real** via `pdfjs-dist` + `@napi-rs/canvas`
  validada isoladamente e via `/api/compare` — texto OCR limpo, sem avisos
  de fonte faltando (`standardFontDataUrl`/`cMapUrl` apontam para os dados
  que já vêm dentro do pacote `pdfjs-dist`).
- OCR com `tesseract.js` (nota: é preciso pedir `{ blocks: true }` no
  terceiro argumento de `.recognize()` — por padrão a árvore
  `blocks/paragraphs/lines/words` vem `null` e só o texto corrido é
  devolvido).
- Todo o fluxo rodado com `MOCK_MODE=true` — nenhuma chamada à Anthropic
  feita durante o desenvolvimento/testes.

## 6. Deploy na Vercel

1. Importe o repositório do GitHub na Vercel.
2. **Root Directory**: `frontend` (o app Next.js não está na raiz do repo).
3. Variáveis de ambiente (Project Settings → Environment Variables):
   - `MOCK_MODE` = `true` (ou `false` + `ANTHROPIC_API_KEY` real, se quiser
     extração de verdade).
4. Nenhuma configuração extra de build é necessária — `next build` já
   cuida de tudo, incluindo os pacotes nativos externos.
5. **Limite de duração de função**: OCR + Claude Vision por página pode
   levar alguns segundos; o projeto já declara
   `export const maxDuration = 60` na rota `/api/compare`. Confira o limite
   de duração de função do seu plano Vercel (varia por plano) e ajuste se
   necessário.

## 7. Limitações conhecidas

- `normalizeCurrency`/`normalizeWeight` usam heurística para decidir
  separador decimal vs. milhar — cobre os casos comuns (BR: `1.500,00`;
  US: `1,500.00`) mas não é 100% robusta para todos os formatos possíveis.
- Quando o documento lista mais de uma empresa (Exportador e Importador), o
  `lib/system-prompt.ts` sempre extrai os dados do Exportador/Shipper —
  fixo, não configurável via API.
- Cada instância fria da função serverless baixa os dados de idioma do
  `tesseract.js` de um CDN na primeira execução (pequena latência extra no
  cold start).
- Sem persistência: nada é salvo em banco de dados ou storage. Cada chamada
  a `/api/compare` é isolada e stateless.
- Sem autenticação/autorização no endpoint — necessário antes de expor a
  qualquer uso além de teste pessoal.
