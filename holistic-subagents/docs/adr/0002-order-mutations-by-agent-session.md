# ADR 0002: Ordenar mutações por Agent Session

## Status

Aceita

## Contexto

Tools, callbacks, eventos Herdr e reconciliação podem alterar a mesma Agent
Session e sua Delegation Run ativa. A fila anterior ordenava apenas algumas
tools pelo ID da Run e permanecia ocupada durante I/O externo. Os demais
writers gravavam diretamente no repository.

Assim, uma operação como `inspect` podia capturar uma Run, aguardar Herdr e
Git, e depois persistir esse snapshot sobre um handoff ou estado mais novo.
`revision` não evita o problema: ela identifica o ciclo semântico da Run e não
avança em toda mudança de handoff, saúde ou Session.

## Decisão

Mudanças na Agent Session e na sua Run ativa pertencem a uma única ordem por
Session. Agent Sessions distintas podem progredir em paralelo.

Cada mudança confirmada avança uma **Session Mutation Sequence** monotônica e
durável. Um resultado calculado fora da seção crítica só pode ser confirmado se
a Sequence observada e a `activeRunId` ainda forem as mesmas. Caso contrário, a
operação retorna `STALE_SESSION_MUTATION`, não grava o snapshot obsoleto e não
faz retry nem compensação. Quando houve I/O, o erro informa que o efeito externo
pode ter ocorrido.

Um módulo profundo de mutação será o writer exclusivo em runtime. Seu seam terá
duas operações de alta intenção:

- `mutate` aplica uma mudança local em uma seção crítica curta;
- `withEffect` captura a versão observada, libera a seção crítica durante I/O e
  reentra para confirmar o resultado.

`withEffect` pode oferecer `checkpoint` para operações como launch e cleanup
persistirem progresso e atualizarem seu próprio token. Sequence, tokens,
ordenação, validação, dual-write e reparação ficam escondidos atrás do seam.
Nenhum `await` ocorre dentro de uma seção crítica.

Tools, callbacks, eventos Herdr, reconciliação, criação, reuso e recovery usam o
mesmo módulo. Callers podem ler snapshots, mas não recebem acesso de escrita ao
repository. O store permanece v2, com records separados de Session e Run. A
ordem de gravação e a reparação determinística de pares incompletos continuam
seguindo a ADR 0001; snapshots antigos começam com Sequence zero.

## Consequências

- O race entre I/O longo e callbacks/eventos não pode mais causar stale write.
- I/O de uma Session não bloqueia seus callbacks nem outras Sessions.
- Efeitos externos podem ocorrer antes de um conflito ser detectado; o caller
  recebe erro explícito e decide o próximo passo.
- O repository vira adapter de persistência atrás do seam de mutação.
- Testes de contrato do módulo passam a ser a superfície principal para ordem,
  paralelismo, stale results e replay após gravação parcial.
- Filas globais de alocação de recurso, como o shared tab pool, permanecem
  separadas da ordem de domínio por Session.

## Alternativas rejeitadas

- Ordenar por Delegation Run: não cobre troca de Run nem mutações da Session.
- Manter o lock durante I/O: bloqueia callbacks e reduz paralelismo.
- Validar apenas `revision`: não detecta toda mudança dentro do mesmo ciclo.
- Permitir writers fora do módulo: torna a garantia dependente de disciplina.
- Criar store v3 ou transação genérica: amplia o escopo sem suporte atômico de
  `pi.appendEntry`; store v2 mais reparação já cobre quedas parciais.
- Dispatcher com um command por caso de uso: aumenta a interface e acopla o
  módulo a todas as operações de produto.
