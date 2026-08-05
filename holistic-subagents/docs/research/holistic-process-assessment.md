# Avaliação do produto e do processo de desenvolvimento

**Base auditada:** master em 17464b13 (Deepen handoff cycle and retire v1,
2026-08-05). Escopo: fontes locais primárias — árvore atual, testes, histórico
Git, documentos e sessões Pi. É diagnóstico, não certificação de release.

O checkout estava limpo antes da redação. Nesta auditoria, npm run check, npm
pack --dry-run e npm audit --omit=dev passaram; o check atual reportou **19
arquivos / 145 testes**.

## Veredito

O holistic-subagents é uma **alpha avançada no núcleo**, não apenas uma skill:
tem domínio explícito, persistência/recovery, controles de autoridade, manifests
íntegros e cinco tools. A confiança no comportamento determinístico é alta. A
confiança na costura Pi + Herdr da refatoração mais recente é média: não há E2E
atual e reproduzível no repositório.

O processo aprende com falhas reais e o reviewer encontrou defeitos antes do
commit. O custo recorrente é coordenação: sessões longas, outputs de tools
grandes e mensagens pós-handoff que abrem novos ciclos. Não se deve remover
reviewer ou reintroduzir polling; deve-se tornar integração, handoff e evidência
mais econômicos e observáveis.

## Maturidade do produto

| Dimensão | Evidência e avaliação |
| --- | --- |
| Domínio e concorrência | CONTEXT.md e ADRs 0001/0002/0004 definem Session, Run, Handoff Cycle, autoridade e ticket. src/domain/session-mutations.ts é writer exclusivo por Session; tests/domain/session-mutations.test.ts cobre Sequence, checkpoint, stale e paralelismo. **Forte.** |
| Handoff | 17464b13 concentrou início, callback autenticado, status Herdr, manifest/artifacts, inspeção e aceite em src/domain/handoff-cycle.ts. tests/domain/handoff-cycle.test.ts:214-718 cobre token/pane/ciclo, ordem claim/idle, reload, inspeção concorrente, reviewer e aceite. TD-001 foi resolvida em 51bb0b32/17464b13: HANDOFF_READY é claim, não aceite. **Forte no domínio.** |
| Segurança/cleanup | src/artifacts/store.ts e seus testes verificam root privado, rename, hash, containment, symlink, permissões e limites; src/security/authority.ts e cleanup.ts verificam Git/ownership. README.md corretamente não chama read-only de sandbox. **Bom, com limite explícito.** |
| Reuso | src/domain/service.ts e tests/domain/service.test.ts:502-814 exigem compatibilidade de CWD/topologia/trust/modelo/autoridade, MRU warm e SESSION_BUSY. Worktree warm continua adiado e testado (:776), em vez de fingir retarget seguro. **Decisão madura.** |
| Empacotamento | O check, pack (32 arquivos) e audit de runtime passaram. AGENTS.md fixa subtree, Git remoto, check e /reload. PLAN.md não mantém trabalho concluído. **Saudável.** |

O histórico é evolução guiada por evidência: Sessions × Runs em a3c89609,
claim/settled em 51bb0b32, mutações/manifests em 0505aeac e v1 removido +
módulo profundo em 17464b13.

## Dívida e riscos técnicos

| Pri. | Finding e evidência | Ação proporcional |
| --- | --- | --- |
| **P1** | **Integração real está defasada do núcleo atual.** TEST_RESULTS.md:5-12 chama de atual uma execução de 2026-08-03 com 18/135, anterior a 17464b13; hoje o check dá 19/145. Os E2E são explicitamente históricos e usam Pi 0.80.x/Herdr 0.7.4/protocol 16 (TEST_RESULTS.md:21-26), mas README.md requer Herdr 0.7.5+/17. Não há tests/e2e/ nem tests/pi/runtime.test.ts; o módulo usa mock de Herdr em tests/domain/handoff-cycle.test.ts:109-124. | Antes de publicar de novo, executar smoke instalado via Git contra as versões requeridas: create/working; callback antes de agent_settled; inspect/accept; reload com claim pendente; cleanup de tab. Registrar SHA e versões. Custo médio, maior redução de risco. |
| **P1 resolvido nesta rodada** | **Documentação de estado atual estava incorreta.** `TEST_RESULTS.md` agora separa a verificação automatizada registrada no SHA `17464b13` dos E2E históricos e informa SHA/data/ambiente. `docs/research/subagent-communication-transports.md` passou a mencionar `pane.read`, o limite de 240 linhas e o fallback v1 **somente como registro histórico**, sempre com a remoção em `17464b13` explícita: control plane na seção 2, estado durável/artifacts na seção 2, item 9 da seção 5 e item 3 da seção 6. O contrato atual afirma que não há fallback por transcript (delegation-contract.md:83-84). | Não tratar os resultados históricos como smoke atual. A lacuna de integração real permanece no finding P1 acima. |
| **P2** | **Erros de evento podem ser silenciosos.** src/pi/runtime.ts:82-86 descarta rejeição de service.onInfrastructureEvent com catch vazio. Sem teste do adapter, falha de persistência/estado pode deixar a Run em working sem diagnóstico. Não há incidente provado; é risco de observabilidade por leitura do código. | Primeiro confirmar a API Pi de log/status. Depois tornar erro visível e/ou pedir reconciliação, com teste de rejeição do runtime. Não alterar Handoff Cycle sem essa evidência. |
| **P2** | **Há vocabulário legado morto.** src/protocol/brief.ts:82 mostra legacy se faltar ciclo, embora criação atômica seja protegida em tests/domain/service.test.ts:239-257 e v1 tenha sido removido. Não é fallback funcional. | Na próxima edição correlata, trocar por estado impossível/erro explícito; não justifica refatoração isolada. |

DEBT.md não contém dívida aberta: TD-001 está resolvida. Isso é diferente das
lacunas de integração, documentação e observabilidade acima.

## Processo: o que funcionou

1. **Eventos em vez de polling.** A sessão
   2026-07-16T20-48-22-872Z_019f6cb0-0558-7e7e-a83e-f7122e7b85f5.jsonl
   registra ao menos 12 polls curtos e 9 leituras de pane nos quatro minutos
   iniciais, apesar de callbacks atendidos em 14–18 s. A regra atual em
   skills/holistic-subagents/SKILL.md:84-105 — confirmar working, parar
   supervisão ativa e inspecionar após sinal — é a correção certa.
2. **Reviewer adversarial teve retorno concreto.** O reviewer
   2026-08-05T12-07-36-019Z_019fd1d2-6b53-76c3-9801-46d0c50def60.jsonl
   encontrou status ADR incorreto, ownership incompleto do Handoff Cycle e,
   por fim, a janela Run ativa sem cycle. A última correção entrou nos testes
   atuais service.test.ts:239-257 e terminou aprovada. Manter review
   independente para lifecycle, persistência, autoridade e cleanup.
3. **Contexto limpo tem semântica correta.** CONTEXT.md e SKILL.md:119-135
   distinguem Session warm de contexto limpo: requiresCleanContext só quando o
   viés é material; /compact não prova isolamento. Não inverter essa decisão.
4. **PLAN/commits preservam história sem poluir o plano.** O mesmo reviewer
   exigiu retirar etapas concluídas; o PLAN.md atual obedece a AGENTS.md.
   17464b13 é unidade lógica com ADR, refatoração e testes.

## Ineficiências recorrentes do processo

| Padrão | Evidência | Melhoria de processo |
| --- | --- | --- |
| **Mensagem pós-handoff abre trabalho novo** | Na sessão TD-001 2026-08-02T02-04-37-070Z_019fc037-4b4e-73f1-9efc-11ba18c600a4.jsonl, pedir finalizar abriu novo turno, invalidou a claim e exigiu novo sinal. A causa é contratual: toda mensagem do pai cria cycleId novo (delegation-contract.md:86-91). | Após ready_for_review, fazer inspect e aceitar/reprovar; não mandar ack/finalizar/reenvio. Só usar holistic_send com correction=true para achado real, limites e checks. Uma frase explícita na checklist da skill é barata. |
| **Contexto/tool output cresce mais que o necessário** | Extração local: o worker de 2026-08-05 acumulou 70 mensagens de assistente e ~719 k caracteres de texto/tool output; o reviewer correspondente teve 8 mensagens e ~848 k. O worker fez Etapas 1/2 e duas correções na mesma Session. A coordenadora 2026-08-02T03-14-02-558Z_019fc076-dabe-73d7-bae2-48fa55fbb17c.jsonl chegou a ~1,29 M caracteres. São caracteres persistidos, **não tokens**. | Limitar delegação a uma etapa + uma correção; após aceite, encerrar ou resumir antes de mudar de etapa. Handoffs curtos com Git/artifacts; não colar diffs/saídas completas. Nova Session só para contexto limpo, compactação só para reduzir a missão corrente. Medir tamanho, retries e tempo até inspect antes de alterar política de modelos. |
| **Review pode ver alvo instável** | O diagnóstico finance-app em 2026-08-01T21-37-02-491Z_019fbf42-521b-7297-90cb-4822009618ff.jsonl registrou reviewer no checkout base, sem conseguir rodar checks do commit revisado, e prompts preemptando trabalho ativo. Esse aprendizado levou a a3c89609. | Aplicar a regra já presente em SKILL.md:119-133: reviewer após executor quieto, com commit/diff/paths fixos e read-only. Para working tree, congelar explicitamente o instante e impedir escrita concorrente. |
| **Resultado de teste não acompanha commit que o invalida** | 262c50a5 atualizou TEST_RESULTS em 03-08; 17464b13 mudou 20 paths em 05-08 e deixou 18/135 como atual. | No gate de commit/publicação, comparar npm test com TEST_RESULTS. Registrar SHA/ambiente, ou renomear o arquivo para histórico e publicar resultado atual como artifact de CI. |

## Priorização

1. **P1, alto impacto/custo médio:** smoke instalado atual de Pi/Herdr após
   17464b13.
2. **P2, impacto médio/custo baixo-médio:** observabilidade/teste de falha da
   subscription em runtime.
3. **P2, ganho cumulativo/custo baixo:** proibir mensagens pós-handoff sem
   correção e limitar contexto/output por etapa antes de otimizar modelos ou
   topologias.

## Não mudar agora

- Não restaurar polling: a sessão de 2026-07-16 demonstra que callbacks já
  acordavam o pai.
- Não restaurar fallback por transcript nem relaxar manifest/artifact/ticket:
  ADR 0004 eliminou v1 para evitar handoff truncado/não íntegro.
- Não adicionar fila, scheduler ou preempção automática para Session busy:
  ADR 0001 e SESSION_BUSY preferem expor disputa a escondê-la.
- Não tratar /compact como contexto limpo e não liberar worktree warm por
  conveniência.
- Não substituir o HandoffCycle por novo kernel genérico: o seam recém-validado
  tem 27 testes; validar adapter real e observabilidade primeiro.

## Fontes e comandos

Fontes: AGENTS.md, CONTEXT.md, DEBT.md, TEST_RESULTS.md, README.md, PLAN.md,
ADRs 0001–0004, src/, tests/ e commits a3c89609, 51bb0b32, 0505aeac,
262c50a5, 17464b13. As sessões são citadas pelo nome de arquivo e somente por
trechos resumidos; nenhum token de callback ou segredo foi transcrito.

Comandos executados: git status --short; git log/git show; rg/nl sobre código,
docs, testes e sessões; npm run check; npm pack --dry-run; npm audit --omit=dev;
git diff --check.
