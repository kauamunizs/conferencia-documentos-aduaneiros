# Conferência de Documentos Aduaneiros

Compara um documento de "Referência" (ex: Invoice) com um "Doc Produzido"
(ex: Certificado de Origem) e cruza os dados vitais (CNPJ, Razão Social,
Endereço, Peso Bruto/Líquido, Valor Total) com tolerância de erro zero.

Projeto 100% Node.js/Next.js — front-end e back-end no mesmo app, pronto
para deploy na Vercel. Veja [`architecture.md`](architecture.md) para os
detalhes do pipeline.

## Rodando localmente

```sh
cd frontend
npm install
npm run dev
```

Abra `http://localhost:3000`.

Por padrão o app roda em **modo mock** (`MOCK_MODE=true` em
`frontend/.env.local`) — nenhuma chamada à API da Anthropic é feita, zero
custo. Os valores extraídos são fixos/de exemplo, mas OCR, comparação e
bounding boxes rodam de verdade.

Para ligar a extração real (paga), edite `frontend/.env.local`:

```
MOCK_MODE=false
ANTHROPIC_API_KEY=sk-ant-sua-chave-real
```

## Outros arquivos

- [`demo.html`](demo.html) — demo estático standalone (HTML/JS puro, sem
  dependências), com dados sintéticos. Só para referência visual.
- [`architecture.md`](architecture.md) — pipeline completo, por que cada
  lib foi escolhida, contrato JSON, instruções de deploy na Vercel.
