# ADR 0001: Separar Agent Sessions de Delegation Runs

## Status

Aceita

## Contexto

A delegação anterior acumulava missão, processo, contexto, recursos e cleanup
em uma única entidade. Isso tornava impossível encerrar uma missão e manter o
agente aquecido sem também manter a missão ativa, além de espalhar decisões de
reuso pelas tools, callbacks e integração Herdr.

## Decisão

O domínio distingue **Agent Session**, dona do processo, contexto, workspace,
recursos e cleanup, de **Delegation Run**, dona de uma missão limitada e de sua
revisão até aceite, falha ou cancelamento. Uma Session executa no máximo uma Run
ativa. Após aceite, a Session fica idle e pode ser reutilizada pela Run
compatível mais recentemente usada; contexto limpo exige Session nova.

Compatibilidade requer escopo de confiança igual, autoridade da Run contida no
teto imutável da Session e o modelo fixo da Session ainda elegível pela Política
Efetiva. Não há fila, preempção ou interpretação de compactação como contexto
limpo. Sem pedido explícito de contexto limpo, a Session compatível MRU é a
escolha: se estiver busy/starting, a criação retorna `SESSION_BUSY` em vez de
abrir outra Session implicitamente.

O CWD físico, workspace e topologia pertencem à Session. Não há retarget de um
processo aquecido: reuso exige CWD canônico e topologia idênticos. Nesta mudança,
Sessions worktree não são reutilizadas porque requests partem do checkout de
origem e não existe retarget explícito para provar o mesmo ambiente físico;
base e branch continuam pertencendo ao request de criação. Reuso worktree fica
adiado. O CWD pedido pela Run continua registrado e auditado, mas precisa
coincidir com o ambiente físico para haver reuso.

O escopo de confiança é derivado da raiz Git canônica. Contenção de autoridade
não usa ranking: read-only cabe em qualquer teto; controlled mutation exige teto
controlled; isolated mutation exige teto isolated. Allowlist vazia de mutação é
workspace-wide, paths são canonicalizados, proibições do teto precisam ser
herdadas e sandbox externo pedido pela Run precisa estar garantido pelo teto.

As tools preservam seus nomes e aceitam Run IDs. Elas cruzam um seam externo
híbrido de operações de alta intenção. Esse módulo profundo esconde o kernel de
estado, eventos, persistência e o adapter Herdr, aumentando leverage para todos
os callers e locality das invariantes. O store v2 separa Sessions e Runs; um
adapter lê registros v1 em memória e toda gravação nova usa somente v2.
Sessions migradas de v1 ficam seladas e não reutilizáveis.

O estado terminal é persistido primeiro na Run. Se houver queda antes de
persistir a Session correspondente, o replay v2 reconhece deterministicamente
`Session busy + Run terminal` e grava uma única reparação idempotente: accepted
leva a Session a idle; failed/cancelled levam a Session a failed/quarentena.

Aceite depende de uma inspeção da revisão atual da Run. Qualquer correção ou
novo evento invalida essa inspeção, evitando aceite de evidência obsoleta.

## Consequências

- Recursos e cleanup têm um único dono durável.
- Perguntas e correções pré-aceite permanecem na mesma Run.
- Uma mensagem para Run terminal é rejeitada e exige nova criação.
- Reviewer aquecido é permitido; isolamento limpo é opt-in explícito.
- Callbacks só são válidos para a Run ativa da Session, mesmo que token e pane
  ainda coincidam após reuso.
- O modelo operacional fica mais profundo internamente sem ampliar a interface
  pública das cinco tools.

## Alternativas rejeitadas

- Encerrar processo junto com toda missão: perde reuso aquecido.
- Tratar cada follow-up como nova Run: fragmenta revisão e evidência.
- Scheduler com fila/preempção: amplia escopo e mascara disputa por Session.
