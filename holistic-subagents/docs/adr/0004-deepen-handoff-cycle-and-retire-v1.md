# ADR 0004: Aprofundar o Handoff Cycle e remover o adapter v1

## Status

Aceita

## Contexto

As garantias do Handoff Cycle estão distribuídas entre callback, reconciliação
Herdr, máquina de estados, inspeção e aceite. Claim, settled, Handoff Manifest,
Artifact Refs, auditoria, Acceptance Ticket e Session Mutation Sequence precisam
mudar em sincronia. A extensão também mantém um adapter v1 e inspeção por
transcript, embora não existam mais Runs v1 abertas e o histórico antigo possa
ser consultado diretamente no Pi.

## Decisão

Um deep Handoff Cycle module será dono do fluxo completo para Runs v2: início e
dispatch do ciclo, autenticação do sinal textual do Agent, observação de status
Herdr normalizado, correlação de claim e settled, validação de manifest e
artifacts, auditoria, emissão e invalidação de Acceptance Ticket, validação das
Runs de verificação e aceite. O module confirmará suas mudanças por
`SessionMutations`; callers usarão operações de alta intenção no mesmo external
seam.

Herdr continuará como adapter de transporte e entregará status normalizado. O
callback textual bruto cruzará o seam para que o Handoff Cycle autentique token,
pane, ciclo e hash. Artifact Roots continuarão pertencendo à Agent Session; o
novo module apenas resolverá e verificará artifacts durante a revisão.

O adapter de store v1, os tipos legados e a inspeção por transcript serão
removidos integralmente. Entradas `holistic-delegation-v1` serão ignoradas pela
extensão. Esta decisão substitui somente a compatibilidade legada definida nas
ADRs 0001 e 0003; o histórico permanece no Pi.

## Consequências

- A interface do Handoff Cycle vira a test surface das invariantes de revisão.
- Testes antigos de modules shallow serão substituídos, não duplicados.
- Runs v1 deixam de aparecer e de ser gerenciadas pela extensão.
- A remoção v1 ocorrerá antes do deepening para separar mudança deliberada de
  regressão v2.
