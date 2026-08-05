# Registro de verificações

Este arquivo é um ledger, não uma garantia de que os comandos foram executados
no checkout atual. Cada registro informa SHA, data e ambiente conhecido.

## Verificação automatizada — snapshot do núcleo atual

- **SHA:** `17464b13475df6f6adfd5d813ea32cb57dd85bee`
- **Data do snapshot:** 2026-08-05 (commit `17464b13`)
- **Ambiente declarado:** Node.js `>=22.19.0`; Pi peer `>=0.79.0`; devDependency
  `@earendil-works/pi-coding-agent` `^0.83.0`; Herdr requerido pelo README:
  `0.7.5+/protocol 17`.
- **Proveniência:** resultado registrado na auditoria desse SHA; **não foi
  reexecutado nesta rodada documental**.

Resultado registrado: `npm run check` passou, com `19` arquivos e `145` testes;
`npm pack --dry-run` passou (32 arquivos, sem `node_modules`) e
`npm audit --omit=dev` não encontrou vulnerabilidades de runtime. O `check`
inclui `npm run typecheck`, `npm test` e `python scripts/validate.py`.

O registro anterior de 2026-08-03, no SHA
`262c50a51690f760a65e202fb8fbfca65a5097d4`, fica preservado como histórico:
typecheck e 18 arquivos/135 testes passaram, assim como validate, pack e audit
conforme anotado na versão anterior deste arquivo. Ele não descreve o estado
posterior a `17464b13`.

## Etapa 3 — smoke instalado atual (bloqueado)

- **SHA base do checkout:** `56dd9cbbd6eba6d79ad6ba52fc0f58cfc027599b`
- **Data:** 2026-08-05T12:12:43-03:00
- **Pi:** `0.83.0`
- **Herdr:** `0.8.0`
- **Protocol:** `19` (`herdr status`: server/client compatíveis)
- **Origem instalada:** `https://github.com/leoszr/holistic-subagents`
- **Commit instalado:** `5be8838496c6d4db42d9b6bb3c1e9b5322144913`
- **Advertência:** este resultado foi executado contra o clone instalado em
  `5be8838`, não contra o SHA base `56dd9cb` nem contra o working tree deste
  checkout. Portanto ele **não valida o checkout**.
- **Harness reutilizado:** sessão Pi interativa hospedada pelo Herdr; comando
  `pi`, sem `-e`, operada por `holistic_*` após `/holistic-mode on`.

### Comandos executados

```text
pi --version
herdr --version
herdr status
herdr api snapshot
herdr api schema --json
herdr tab create --workspace w3M --cwd <checkout> --label "Etapa 3 smoke" --no-focus
herdr agent start smoke --kind pi --pane <root-pane> --timeout 120000
herdr agent prompt <root-pane> <smoke Etapa 3> --wait --until idle --timeout 900000
herdr agent get <root-pane>
herdr agent read <root-pane> --source recent-unwrapped --lines 120
herdr tab close <smoke-tab>
herdr api snapshot
```

### Resultado

- **create/working:** BLOQUEADO. O `holistic_create` instalado com
  `topology=tab` falhou com `did not publish an interactive Pi session`.
- **claim antes de settled:** não executado; dependia da criação do filho.
- **inspect/accept:** não executado; dependia da criação do filho.
- **reload com claim pendente:** não executado; dependia da criação do filho.
- **cleanup de tab:** limpeza direta pelo Herdr passou: tabs/panes efêmeros
  `w3M:t8/w3M:pB` e `w3M:t9/w3M:pC` foram removidos, e o tab do harness
  `w3M:t7` também foi fechado. O `holistic_manage cleanup` falhou antes com
  `ownership metadata does not match`; isso não é equivalente à validação do
  cleanup integrado.

O agente smoke terminou `done` e seu relatório confirmou que não houve
alteração no checkout, testes, `npm run check`, commit ou push. O comando
`herdr agent prompt ... --wait` terminou com timeout ao aguardar o estado,
embora `herdr agent get/read` já mostrassem a sessão concluída. Após o cleanup,
o snapshot manteve apenas os tabs preexistentes `w3M:t1`, `w3M:t5` e `w3M:t6`.

**Limitação real:** a Etapa 3 não foi concluída. O bloqueio está na integração
instalada de criação de uma sessão Pi interativa; não há evidência para afirmar
os quatro critérios dependentes. A Etapa 3 permanece em `PLAN.md`.

## Etapa 3 — correção direcionada e repetição no checkout (bloqueada)

- **Data:** 2026-08-05T12:47:38-03:00
- **SHA base:** `56dd9cbbd6eba6d79ad6ba52fc0f58cfc027599b`
- **Working tree testado:** SHA base acima + diff local `248f885c6f08db50c69689e5b580ee753f64d5f94fd7d4340c557f0589084c12`
- **Node:** `v24.16.0`
- **Pi:** `0.83.0`
- **Herdr:** `0.8.0`, client/server compatíveis, **protocol 19**
- **Origem persistente restaurada ao final:**
  `git:github.com/leoszr/holistic-subagents`, clone em
  `~/.pi/agent/git/github.com/leoszr/holistic-subagents`, commit
  `5be8838496c6d4db42d9b6bb3c1e9b5322144913`.

### Correção aplicada

- `HerdrTopologyManager` agora grava `pane.report_metadata` e, em worktree,
  `workspace.report_metadata` antes de `agent.start`. Assim recursos parciais
  continuam limpáveis quando o filho falha antes de `interactive_ready`.
- A barreira `agent.start`/`agent.get` foi ampliada de 10 s para 20 s. O
  contrato observado no Herdr 0.8.0 usa `launch_pending`; `agent_session` só
  apareceu depois de aproximadamente 10,5 s no check real.
- Testes direcionados:

```text
npx vitest run tests/herdr/topologies.test.ts tests/security/cleanup.test.ts
11 tests passed (7 topology, 4 cleanup)
```

Os testes cobrem startup atrasado, falha antes de `interactive_ready`, metadata
prévia e bloqueio de cleanup quando o pane tem ownership estrangeiro.

### Check barato real de Herdr

Comando usado: script Node com `HerdrClient` local, `session.snapshot` via
`minimumProtocol: 19`, `tab.create`, `pane.process_info`, `agent.start`,
`agent.get`, `events.subscribe` e `tab.close`.

- `agent.start`: passou após 3 retries `agent_pane_busy`, comportamento permitido
  pelo contrato atual.
- `agent.get`: primeiro retornou `launch_pending: true`; depois retornou
  `interactive_ready: true` e `agent_session` após aproximadamente 10,5 s.
- eventos: a subscription NDJSON entregou eventos `pane_agent_detected`.
  Limitação observada: o filtro usado no probe também recebeu IDs de panes
  preexistentes; isso não foi tratado como prova de filtragem por pane.
- tab e pane do probe foram removidos.

### Instalação e smoke

Comandos relevantes:

```text
pi install . --no-approve
herdr tab create --workspace w3M --cwd <checkout> --label "Etapa 3 smoke checkout" --no-focus
herdr agent start smoke-r3 --kind pi --pane <root-pane> --timeout 120000
herdr agent prompt <agent> <smoke Etapa 3> --wait --until idle --timeout 900000
```

Foi preparado um overlay local temporário para alinhar o clone do pacote ao
working tree. Ele foi restaurado ao clone GitHub original antes do término.
Nas sessões novas, Pi iniciou, mas a sessão coordenadora não expôs as tools
`holistic_*` ao agente; mesmo após `/holistic-mode on` e `/reload`, o relatório
foi `As tools holistic_* continuam indisponíveis nesta sessão`. Diagnóstico: foi
um erro do harness, não do pacote. `HOLISTIC_SUBAGENT_DEPTH=1` identifica uma
sessão filha e deliberadamente impede o registro das tools `holistic_*`; o
harness iniciou o suposto coordenador com essa variável. Por segurança, o smoke
não foi substituído por CLI/manual e os critérios abaixo não foram executados:

- create/working: **não executado**;
- claim antes de settled: **não executado**;
- inspect/accept: **não executado**;
- reload com claim pendente: **não executado**;
- cleanup integrado de tab: **não executado**.

Cleanup direto do Herdr removeu as tabs temporárias `w3M:tF`, `w3M:tH`,
`w3M:tK` e `w3M:tJ`. O snapshot final manteve apenas as tabs preexistentes
`w3M:t1`, `w3M:t5` e `w3M:t6`. Isso é somente cleanup direto; não valida
`holistic_manage cleanup` nem a integração do checkout.

**Limitação real:** a barreira e o ownership foram validados por testes
direcionados e pelo check barato real, mas a repetição E2E da Etapa 3 ficou
bloqueada pela ausência das tools `holistic_*` na sessão Pi local. A Etapa 3
permanece em `PLAN.md`; a Etapa 4 foi preservada. Não houve `npm run check`,
suíte unitária completa, commit ou push.

## Etapa 3 — terceira tentativa: harness corrigido (bloqueada)

- **Data:** 2026-08-05T13:01:10-03:00
- **SHA base:** `56dd9cbbd6eba6d79ad6ba52fc0f58cfc027599b`
- **Working tree testado:** SHA base + diff local `da6ff8bf32f14422569900c1557a9572c6cf83825150a1ee508268c8d8187fa0`
- **Node/Pi:** `v24.16.0` / `0.83.0`
- **Herdr:** `0.8.0`, client/server compatíveis, **protocol 19**
- **Identidade carregada:** mecanismo oficial de desenvolvimento local, com
  `-e ./extensions/holistic-subagents.ts`, `--no-extensions`,
  `--skill ./skills/holistic-subagents` e `--no-skills`; portanto, o código
  carregado foi o working tree acima, sem colisão com o clone instalado.
- **Ambiente confirmado no pane coordenador:** `HERDR_ENV=1`,
  `HOLISTIC_SUBAGENT_DEPTH=` vazio, `HERDR_SOCKET_PATH=/home/leo/.config/herdr/herdr.sock`,
  `HERDR_PANE_ID=w3M:pR`, `HERDR_WORKSPACE_ID=w3M`, `HERDR_TAB_ID=w3M:tN`.
- **Instalação persistente:** restaurada para
  `git:github.com/leoszr/holistic-subagents`, commit instalado
  `5be8838496c6d4db42d9b6bb3c1e9b5322144913`.

### Harness e check barato

Comandos executados:

```text
herdr tab create --workspace w3M --cwd <checkout> --label "R3 coordinator harness exact" --no-focus --env HERDR_ENV=1 --env HOLISTIC_SUBAGENT_DEPTH= --env PI_OFFLINE=1
herdr agent start coord-r3-exact --kind pi --pane w3M:pR --timeout 120000 -- --no-extensions -e ./extensions/holistic-subagents.ts --no-skills --skill ./skills/holistic-subagents
herdr pane send-text w3M:pR '/holistic-mode on'
herdr agent prompt coord-r3-exact '<check somente de holistic_create>' --wait --until idle --timeout 120000
```

O coordenador iniciou com `interactive_ready=true`, `/holistic-mode on` exibiu
`subagents: on`, e respondeu: `Sim, holistic_create está disponível nesta
sessão coordenadora.` **Check barato: PASS.** Nenhum filho foi criado nesse
check.

### Smoke integrado, uma única execução

O coordenador recebeu a solicitação para usar `holistic_create`, sem pedir ao
filho qualquer tool do coordenador. Eventos/resultados observados:

- `holistic_create`: criou o run/tab `830854f9-d89a-4dfc-b9ea-b9aa38803076`
  em `working`. **create/working: PASS**.
- `holistic_list`: observou `working`; em seguida observou `failed`.
- `holistic_send`: falhou com `timed out waiting for agent status`; o filho
  falhou antes de emitir claim. **claim antes de settled: FAIL**.
- `holistic_inspect`: bloqueado por `RUN_NOT_REVIEWABLE` no run failed.
  **inspect/accept: BLOQUEADO**.
- Não houve claim pendente, portanto reload não foi executado.
  **reload com claim pendente: BLOQUEADO**.
- `holistic_manage cleanup` foi executado para a tab dedicada e não deixou a
  tab temporária. **cleanup integrado de tab: PASS**.

O coordenador não executou testes unitários, suíte completa ou `npm run check`.
A Etapa 3 permanece em `PLAN.md` porque os critérios de claim, inspect/accept e
reload não passaram. O tab coordenador `w3M:tN` também foi fechado; o snapshot
final manteve somente os tabs preexistentes `w3M:t1`, `w3M:t5` e `w3M:t6`.
Não houve commit ou push.

## Auditoria histórica de compatibilidade: Herdr 0.7.5 / protocol 17

Auditoria registrada em 2026-07-21 contra o CLI/schema local (protocol 17),
documentação oficial e release v0.7.5. O fluxo real
`pane.split -> agent.start -> agent.prompt` iniciou Pi, observou `working` e
removeu o pane criado.

Os E2E abaixo são registros históricos da migração. A execução ocorreu no
ambiente informado e não substitui a verificação automatizada atual.

Ambiente dos E2E: Pi 0.80.x, Herdr 0.7.4/protocol 16, repositório Git real e sessões Pi
interativas sem foco. Todos os panes, tabs, workspaces e worktrees criados pelo
E2E foram removidos ao final.

## Automação histórica da migração

- cobertura exercitada: state machine, event log, socket NDJSON, topologias,
  resolver, callbacks, reconciliação, autoridade, cleanup e service;

## Socket Herdr real

- confirmado que requests comuns usam uma conexão por request;
- `events.subscribe` exige `pane_id` e mantém uma conexão dedicada;
- runtime alterado para uma subscription por pane ativo, adicionada/removida
  conforme o ledger, sem polling;
- snapshot, metadata, `agent.start`, waits, pane read/input e cleanup foram
  exercitados no servidor real.

## E2E pane

- coordenador carregou as cinco tools pelo pacote instalado;
- `holistic_create` lançou filho Luna low em pane;
- filho leu `package.json`, enviou callback autenticado e encerrou o turno;
- hook `input` transformou o sinal e despertou o pai;
- pai executou `holistic_inspect`, recebeu audit limpo, aceitou e fechou;
- pane filho desapareceu e a delegação terminou `closed`.

## E2E tab

- tab e root pane foram criados sem foco e o filho retornou por callback;
- primeiro cleanup revelou que apenas o pane do agente recebia metadata, não o
  root pane criado pela tab;
- implementação passou a marcar todos os panes do ledger;
- após reload e metadata reparada no fixture, cleanup fechou a tab inteira e
  terminou `closed` sem recurso residual.

## E2E worktree

- primeira criação revelou timeout de cinco segundos apesar de o Herdr concluir
  a worktree; timeout específico foi elevado para 120 segundos;
- tentativas seguintes criaram worktree, workspace, root pane, pane Pi, branch,
  callback e handoff com audit estruturado limpo;
- worktree real foi removida pelo cleanup;
- o E2E revelou dois ajustes adicionais: preservar o cwd original separado do
  runtime cwd e remover a worktree antes de fechar seus panes/workspace;
- branch cleanup passou a executar no checkout original após a worktree sumir;
- nenhuma branch `agent/worktree-read-e2e*`, worktree vinculada ou workspace E2E
  permaneceu.

O filho produziu uma afirmação textual incorreta de Git sujo enquanto
`holistic_inspect` retornava `Authority: ok` e `gitStatus: ""`. A skill agora
manda o pai confiar no audit estruturado do cwd/baseline corretos, não em
self-report contraditório.

## Instalação e migração

- `pi install .`: passou e a origem local aparece em `pi list`;
- a cópia standalone antiga da skill foi movida para
  `~/.pi/agent/backups/holistic-subagents-standalone-20260720-191043` para
  eliminar colisão de descoberta;
- manifest usa `skills/holistic-subagents` e a extensão TypeScript como
  recursos convencionais do mesmo pacote;
- sessão nova carregou 21 extensions e 15 skills, sem mensagem de colisão,
  confirmando descoberta da skill pelo pacote reinstalado;
- sessões filhas carregaram a extensão Codex existente e não receberam tools
  coordenadoras por causa de `HOLISTIC_SUBAGENT_DEPTH`.

## Etapa 3 — correção do timeout de dispatch (bloqueada)

- **Data:** 2026-08-05T13:18:53-03:00
- **SHA base:** `56dd9cbbd6eba6d79ad6ba52fc0f58cfc027599b`
- **Working tree testado:** SHA base + diff direcionado
  `9e70e221472ac2003b392795e71361863c9a160ded2d2b95e0fb2786a4c029f`
- **Node:** `v24.16.0`; **Pi:** `0.83.0`
- **Herdr:** `0.8.0`, client/server compatíveis, **protocol 19**
- **Origem persistente:** `git:github.com/leoszr/holistic-subagents`, clone
  instalado em `5be8838496c6d4db42d9b6bb3c1e9b5322144913`; o smoke desta
  seção carregou explicitamente o working tree por:
  `pi --no-extensions -e ./extensions/holistic-subagents.ts --no-skills --skill ./skills/holistic-subagents`.

### Contrato confirmado antes da edição

`herdr 0.8.0` documenta que `agent.prompt --wait --until working` espera uma
transição observada após a submissão e pode retornar timeout/stalled; sem
`--wait`, a submissão não aguarda nova transição. O contrato real de
`agent.start` continua sendo a prontidão interativa, enquanto `agent.get` e
eventos observam o estado. `herdr status` confirmou protocol 19. A correção
removeu `wait` somente do `agent.prompt` de follow-up em
`src/domain/handoff-cycle.ts`; o wait do launch inicial permaneceu em
`src/herdr/topologies.ts`/`DelegationService`.

### Correção e checks direcionados

- `dispatch` agora envia follow-up sem `wait.until=working`.
- Timeout/erro após a submissão mantém Run e Session ativos, grava
  `handoff.effectMayHaveOccurred` e `health=dispatch_uncertain`, e bloqueia
  nova entrega com `HANDOFF_RECONCILIATION_REQUIRED`.
- `reconcileDispatch` só libera nova entrega após conferir Run ativo no store,
  pane e ownership no snapshot e, quando há claim, manifest/artifacts.
  A operação é de alto nível; não expõe primitives ao service.
- Comandos executados:

  ```text
  herdr --version
  herdr agent prompt --help
  herdr agent start --help
  herdr agent get --help
  npx vitest run tests/domain/handoff-cycle.test.ts
  npx tsc --noEmit
  git diff --check
  ```

- Resultado: `tests/domain/handoff-cycle.test.ts` passou, **28 testes**; o
  typecheck e `git diff --check` passaram. Não foram repetidos os 11 testes
  aprovados de ownership/rollback. Não foram executados suíte completa,
  `npm run check` ou commit/push.

### Smoke integrado, uma única execução após a correção

- Coordenador real em Herdr: tab `w3M:tQ`, pane `w3M:pT`; ambiente
  `HERDR_ENV=1`, `HOLISTIC_SUBAGENT_DEPTH` vazio e IDs válidos. `agent.start`
  retornou `interactive_ready=true`; `/holistic-mode on` confirmou
  `holistic_create`. Check barato: **PASS**.
- `holistic_create` criou somente a run
  `1b41ce43-86dc-4bc4-bf75-0a1c94773a8e`, tab `w3M:tR`, em `working`:
  **create/working PASS**.
- O filho recebeu e executou o follow-up. O coordenador tentou observá-lo e
  retomá-lo enquanto ainda estava `working`; o `HOLISTIC_HANDOFF_READY` só
  chegou depois do deadline operacional observado. Portanto
  **claim antes de settled FAIL** para o critério temporal. O filho publicou o
  claim tardiamente; isso não prova dispatch oportuno nem recuperação do
  timeout.
- `inspect/accept`: **BLOQUEADO**. O Run permaneceu `working` no store e
  `holistic_inspect` retornou `RUN_NOT_REVIEWABLE`.
- `reload/resume com claim pendente`: **PASS observado no harness**; houve
  `holistic_send` enquanto a run ainda estava `working`, antes do claim tardio.
  Isso não compensa a falha de settled/inspect.
- `holistic_manage cleanup`: **BLOQUEADO** por `SESSION_BUSY`; não alegar
  cleanup integrado. Depois, o fechamento direto seguro `herdr tab close
  w3M:tR` passou, mas cleanup direto não prova recuperação de handoff tardio.
  O tab temporário do coordenador `w3M:tQ` também foi fechado; permaneceram
  apenas `w3M:t1`, `w3M:t5` e `w3M:t6`.

A Etapa 3 permanece em `PLAN.md`; a Etapa 4 foi preservada. O filho não foi
reentregue após o claim tardio. Não houve commit ou push.

## Etapa 3 — P1 de dispatch: ack, guard e reconciliação (implementada, smoke pendente)

- **Data:** 2026-08-05T13:48:03-03:00
- **SHA base:** `56dd9cbbd6eba6d79ad6ba52fc0f58cfc027599b`
- **Diff acumulado da Rodada 3 (arquivos de domínio/testes):**
  `81b5ca5d7ace67c9f348d5cb86004e5be21abf51603d68ba76bb4032fda46abe`
  (`git diff HEAD -- src/domain/handoff-cycle.ts src/domain/types.ts
  src/domain/service.ts tests/domain/handoff-cycle.test.ts
  tests/domain/service.test.ts`).
- **Node:** `v24.16.0`; **Pi:** `0.83.0`; **Herdr:** `0.8.0`, **protocol 19**.
- Não houve smoke nesta rodada (proibido até a revisão dos P1). Não houve
  suíte completa, `npm run check`, commit ou push.

### Correções aplicadas (P1 de dispatch)

1. **Ack sem wait não registra `handoff.working`.** O confirm de
   `agent.prompt` sem `wait` apenas limpa o guard; `handoff.working` passou a
   vir somente de evento/snapshot Herdr correlacionado
   (`recordRuntimeStatus`/`persistRuntimeStatus`). O launch inicial continua
   com `wait.until=working` e registra working via `confirmDispatch`.
2. **Guard persistido antes do I/O.** `handoff.dispatchPending` é gravado na
   mesma mutação que inicia o ciclo, antes do `agent.prompt`. Um segundo
   `dispatch` concorrente é rejeitado com `DISPATCH_IN_PROGRESS` sem mutação
   nem I/O externo. Em `STALE_SESSION_MUTATION` (evento avançou a Sequence
   durante o voo), apenas o guard é liberado; o estado mais novo permanece
   autoritativo.
3. **Erro após possível submissão permanece incerto.** `#failPromptDispatch`
   mantém Run/Session ativos, grava `handoff.effectMayHaveOccurred`,
   `health=dispatch_uncertain` e bloqueia reenvio com
   `HANDOFF_RECONCILIATION_REQUIRED`.
4. **Reconciliação estrita.** `reconcileDispatch` exige delegação completa
   (Run ativo no Session) e ownership completo (owner presente e igual ao
   token truncado do recurso). Pane existente, claim ausente ou ownership
   incompleto nunca limpam `effectMayHaveOccurred`. Evidência conclusiva =
   claim válido do ciclo atual (valida manifest/artifacts); abandono explícito
   seguro = `manage fail/close`. Callbacks válidos do ciclo atual (question,
   input_required, handoff_ready) também limpam os marcadores, pois provam que
   o filho recebeu o follow-up (evita deadlock ao responder pergunta).
5. **Recuperação de alto nível.** `DelegationService.reconcileDispatch` é a
   porta de recuperação; nenhuma tool pública nova foi adicionada e não há
   retry automático (o `dispatch` continua rejeitando enquanto incerto).

### Testes de regressão executados

```text
npx vitest run tests/domain/handoff-cycle.test.ts tests/domain/service.test.ts
31 + 32 = 63 tests passed
npx tsc --noEmit  (passou)
git diff --check  (passou)
```

Cobertura nova: (1) ack sem evento working não assenta (idle mantém working,
sem settled); (2) dispatch concorrente produz um único `agent.prompt` e o
segundo é rejeitado com `DISPATCH_IN_PROGRESS`; (3) pane existente, pane
ausente, ownership ausente/divergente e ausência de claim não liberam reenvio;
(4) claim conclusivo do ciclo atual limpa a incerteza e reabilita follow-up.
Testes diretamente relacionados de service foram atualizados para o novo
contrato (sem `wait` no follow-up, sem `handoff.working` no ack, Run incerto
em vez de failed, e evento working explícito antes de settled).

**Limitação real:** a correção está validada por testes de domínio e service;
o smoke integrado da Etapa 3 não foi repetido nesta rodada (aguarda revisão).
A Etapa 3 permanece em `PLAN.md`.

## Etapa 3 — P1 de dispatch pós-revisão (implementada, smoke pendente)

- **Data:** 2026-08-05T14:01:06-03:00
- **SHA base:** `56dd9cbbd6eba6d79ad6ba52fc0f58cfc027599b`
- **Diff acumulado da Rodada 3 (dispatch; 4 fontes + 3 arquivos de teste):**
  `fe5720f27462fd170922933b6a4b899fe8b556fa63a3e6a9b2b91f14ae4d0a06`
  (`git diff HEAD -- src/domain/handoff-cycle.ts src/domain/store.ts
  src/domain/service.ts src/pi/runtime.ts tests/domain/handoff-cycle.test.ts
  tests/domain/service.test.ts tests/domain/store.test.ts`).
- **Node:** `v24.16.0`; **Pi:** `0.83.0`; **Herdr:** `0.8.0`, **protocol 19**.
- Não houve smoke nesta rodada (proibido). Não houve suíte completa,
  `npm run check`, commit ou push.

### Correções aplicadas (findings da revisão)

1. **P1 — STALE com entrega possível vira incerteza.** No `dispatch`, quando
   `STALE_SESSION_MUTATION` acontece com o prompt em voo, o ciclo NÃO é
   liberado: `dispatchPending` é removido e o ciclo vira
   `dispatch_uncertain` + `effectMayHaveOccurred` + failure, com reenvio
   bloqueado. A exceção: evidência conclusiva já persistida do mesmo ciclo
   (claim/question válido — que limpa o próprio guard via
   `clearDispatchUncertainty`) não gera incerteza. O teste que consagrava a
   liberação insegura foi substituído por dois: um de incerteza e um de
   evidência conclusiva persistida.
2. **P1 — reload/crash promove guard órfão.** `DelegationRepository`
   (`#recoverSessions`) agora trata `handoff.dispatchPending` persistido como
   órfão: promove para `dispatch_uncertain`/`effectMayHaveOccurred` (retry
   bloqueado até claim conclusivo ou abandono explícito), salvo quando um
   claim do mesmo ciclo já foi persistido — aí apenas o guard é descartado.
   Idempotente (reloads seguintes não geram novas mutações).
3. **P1 — sem `HerdrSnapshot` bruto na interface pública.**
   `DelegationService.reconcileDispatch(runId)` agora busca o snapshot
   internamente via `session.snapshot` e valida antes de delegar ao
   `HandoffCycle`. A recuperação também foi integrada ao startup: o
   `reconcile(snapshot)` existente (chamado pelo runtime após `connect`)
   libera ciclos incertos cujo claim conclusivo já está persistido e cuja
   metadata valida; sem claim, a incerteza permanece (sem retry automático).
   Nenhuma tool pública nova; `runtime.ts` aguarda o `reconcile` async.
4. **P2 — metadata completa antes de qualquer conclusão.** `reconcileDispatch`
   exige, além do pane e do owner (`tokens.owner` = ownership token truncado
   do recurso): `tokens.delegation` igual a `session.ownershipId` (contrato de
   `pane.report_metadata` do launch) e recursos `tab`/`workspace` do Session
   correlacionados ao `tab_id`/`workspace_id` do pane no snapshot. Ausência ou
   divergência preserva a incerteza — nunca libera retry.

### Testes de regressão executados

```text
npx vitest run tests/domain/handoff-cycle.test.ts tests/domain/service.test.ts tests/domain/store.test.ts
33 + 35 + 12 = 80 tests passed
npx tsc --noEmit  (passou)
git diff --check  (passou)
```

Cobertura nova/ajustada: STALE sem evidência → incerto e bloqueado; STALE com
claim do mesmo ciclo → sem incerteza; reload promove guard órfão (com e sem
claim persistido); matriz de reconciliação (pane ausente, owner ausente/
divergente, delegation ausente/divergente, tab/workspace divergente, sem
claim); sucesso da reconciliação só com claim + metadata completa;
`reconcileDispatch(runId)` busca o snapshot internamente; `reconcile(snapshot)`
do startup libera só incerteza conclusiva e mantém bloqueado sem claim.

**Limitação real:** continua sem smoke integrado; a Etapa 3 permanece em
`PLAN.md` aguardando revisão e reexecução do coordenador.

## Etapa 3 — P1 de dispatch, correção 2 (implementada, smoke pendente)

- **Data:** 2026-08-05T14:10:20-03:00
- **SHA base:** `56dd9cbbd6eba6d79ad6ba52fc0f58cfc027599b`
- **Diff acumulado da Rodada 3 (dispatch; 4 fontes + 3 arquivos de teste):**
  `9c3127d7002993d8e8c5bc3854ccefa3dc9c717a521f5d2c82c2a4ef3034a47d`
  (`git diff HEAD -- src/domain/handoff-cycle.ts src/domain/store.ts
  src/domain/service.ts src/pi/runtime.ts tests/domain/handoff-cycle.test.ts
  tests/domain/service.test.ts tests/domain/store.test.ts`).
- **Node:** `v24.16.0`; **Pi:** `0.83.0`; **Herdr:** `0.8.0`, **protocol 19**.
- Não houve smoke, suíte completa, `npm run check`, commit ou push.

### P1(1) — Store/reload: guard órfão sempre promovido a incerteza

`#recoverSessions()` agora promove **todo** `dispatchPending` órfão para
`effectMayHaveOccurred`/`dispatch_uncertain`, preservando o `handoff` intacto
(`claimed`, `manifestId`, `manifestSha256` e `settled` continuam no objeto).
Claim persistido, hash textual ou estado `ready_for_review` **nunca** limpam o
guard no replay: o claim é preservado, mas não tratado como conclusivo.
Somente a reconciliação de startup resolve a incerteza — e só depois de
`loadManifest` validar o hash real do artefato e a metadata completa
correlacionada (pane delegation+owner, tab/workspace IDs).

### P1(2) — Startup: operação de alta intenção sem snapshot do caller

- `runtime.ts` chama apenas `client.connect()` + `service.reconcileStartup()`.
  O `isSafeReconciliationSnapshot` foi removido do runtime (validação agora é
  interna ao service).
- `DelegationService.reconcileStartup()` obtém o snapshot internamente via
  `session.snapshot`, valida-o e executa `reconcileSnapshot` + recuperação de
  dispatch pelo mesmo fluxo conclusivo de `reconcileDispatch` (claim válido do
  ciclo atual + manifest/hash validado + ownership completa).
- `HandoffCycle.reconcileDispatch(runId)` não recebe mais `HerdrSnapshot` de
  caller nenhum: busca o snapshot internamente via `session.snapshot` antes de
  validar pane/owner/delegation/tab/workspace/manifest. O `reconcile(snapshot)`
  público do service foi removido.
- Sem retry automático (erros de reconciliação preservam a incerteza) e sem
  tool pública nova.

### Testes de regressão executados

```text
npx vitest run tests/domain/handoff-cycle.test.ts tests/domain/service.test.ts tests/domain/store.test.ts
33 + 35 + 13 = 81 tests passed
npx tsc --noEmit  (passou)
git diff --check  (passou)
```

Mudanças: `store.test.ts` — removido o `manifestSha256: "abc"` inválido;
substituído o teste que "dropava" o guard por claim por dois testes novos:
replay preserva claim completo (`ready_for_review` + hash válido de 64 hex) e
mantém a incerteza, e replay mantém retry bloqueado para claim incompleto (sem
manifestId/hash). `handoff-cycle.test.ts` — matriz de reconciliação e teste de
sucesso agora mockam `session.snapshot` (a primitiva busca internamente).
`service.test.ts` — os 3 testes de reconciliação passam a usar
`reconcileStartup()`/`reconcileDispatch(runId)` com o snapshot servido pelo
mock interno, incluindo o assert de que `session.snapshot` é chamada.

**Limitação real:** continua sem smoke integrado; a Etapa 3 permanece em
`PLAN.md` aguardando revisão e reexecução do coordenador.
