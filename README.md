# Dashboard COMEX

Painel de rotina de trabalho para exportação (granel), em arquivo único:
`comex-dashboard.html`. Publicado por GitHub Pages a cada push nesta branch.

## Páginas

- **Dashboard** — o que está em aberto agora, indicadores do dia, lançamento
  de novos registros, lotes prontos para importar, rendimento da semana e
  relatório (semanal/mensal, em tabela, resumo escrito, CSV ou e-mail).
- **Histórico** — todos os processos registrados, do maior número para o
  menor, com filtros e paginação.
- **México** — follow-up de DUEs à espera de documentação, com cruzamento
  automático de um follow-up novo, exportação em CSV e geração do `.xlsx` no
  mesmo formato da planilha enviada ao chefe.
- **Tutorial** — referência dos fluxos operacionais, com link para o
  [passo a passo de lançamento de CE](tutorial-ce/).

## Dados

Tudo fica no `localStorage` do navegador. A sincronização opcional por Gist
replica os dados entre computadores, mesclando registro por registro (quem
editou mais recentemente ganha), então nenhum PC sobrescreve o outro.

`mexico-seed.json` é a base inicial do follow-up (planilha de 03/09/2026).
Só é buscada no primeiro acesso, quando ainda não há nada salvo.

## Lotes

`lotes/index.json` lista lotes de registros prontos; cada um aponta para um
`lotes/<id>.json`. O dashboard mostra os lotes disponíveis e importa com um
clique, sem copiar e colar.

---

O projeto original deste repositório (conferência de documentos aduaneiros,
app Next.js) está na branch `master`.
