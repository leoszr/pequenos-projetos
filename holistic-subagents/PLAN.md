# Plano atual

## Objetivo

Aplicar as melhorias priorizadas em
`docs/research/holistic-process-assessment.md` sem ampliar o produto além das
evidências da auditoria.

## Etapa 3 — Validar a integração real atual

- Executar smoke instalado contra as versões requeridas de Pi e Herdr.
- Cobrir create/working, claim antes de settled, inspect/accept, reload com
  claim pendente e cleanup de tab.
- Registrar SHA, versões, comandos, resultados e limitações.

### Rodada 3 — correções de dispatch (implementadas, aguardando revisão)

- Follow-up sem `wait` no `agent.prompt`; ack não registra `handoff.working`
  (working só via evento/snapshot Herdr correlacionado).
- Guard persistido `handoff.dispatchPending` antes do I/O; segundo dispatch
  concorrente rejeitado com `DISPATCH_IN_PROGRESS` sem efeito externo.
- Erro após possível submissão mantém Run/Session ativos com
  `effectMayHaveOccurred` e bloqueia reenvio.
- `STALE_SESSION_MUTATION` com entrega possível também vira
  `dispatch_uncertain`/`effectMayHaveOccurred` (salvo claim conclusivo do
  mesmo ciclo já persistido); reload/crash promove guard órfão da mesma forma
  (no `DelegationRepository`): todo `dispatchPending` órfão vira
  `effectMayHaveOccurred`/`dispatch_uncertain` preservando `claimed`/hash —
  claim persistido ou `ready_for_review` nunca limpam o guard no replay;
  somente a reconciliação de startup resolve (após `loadManifest` validar o
  hash e a metadata completa correlacionada).
- Recuperação via operações de alto nível (sem tool pública): a primitive
  `HandoffCycle.reconcileDispatch(runId)` busca o snapshot internamente
  (`session.snapshot`), exige `tokens.owner` + `tokens.delegation` + recursos
  `tab`/`workspace` correlacionados e só libera com evidência conclusiva
  (claim válido do ciclo atual, manifest/hash validado) ou abandono explícito
  via `manage fail/close`. O startup (`runtime.ts`) chama
  `DelegationService.reconcileStartup()` — obtém e valida o snapshot
  internamente, executa `reconcileSnapshot` + recuperação pelo mesmo fluxo;
  sem retry automático.
- Smoke da Etapa 3 ainda não repetido; pendente revisão desta rodada.

## Etapa 4 — Economizar o processo de handoff

- Proibir mensagens pós-handoff sem correção real.
- Limitar output e contexto por etapa.
- Usar `/compact` entre tasks próximas em contexto e `/new` quando o domínio da
  próxima task for materialmente diferente.
- Manter revisão sobre alvo estável e evidência direcionada.
