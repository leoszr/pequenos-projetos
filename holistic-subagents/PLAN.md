# Plano — pacote híbrido de delegações persistentes para Pi + Herdr

## Contexto

O repositório entrega hoje somente a skill declarativa `holistic-subagents`.
Ela ensina o agente principal a decidir quando delegar, montar briefs, escolher
modelo/thinking, operar o Herdr por comandos e validar o handoff. O fluxo já
foi testado manualmente, mas lifecycle, estado, eventos, ownership e cleanup
dependem de instruções em Markdown e de o modelo executar corretamente vários
comandos de baixo nível.

O objetivo deste trabalho é entregar a **extensão completa**, sem substituir a
skill nem o Herdr:

> A skill decide; a extensão executa e registra; o Herdr hospeda; o agente
> principal valida.

A unidade de domínio continuará sendo uma delegação dinâmica — missão,
contexto, autoridade, critérios, ambiente, política de modelo, estado,
recursos e evidências — e não um catálogo de papéis fixos.

### Estado atual confirmado

- Não existe código de extensão neste checkout nem implementação recuperável
  no histórico deste repositório; os antigos `pi-miniagents` e `markdown-app`
  eram gitlinks removidos e seus objetos não estão disponíveis localmente.
- O Pi instalado suporta pacotes híbridos via `package.json`, extensões
  TypeScript, tools, slash commands, UI customizada, hooks `input`/lifecycle,
  `ctx.modelRegistry` e persistência por `pi.appendEntry`.
- O Herdr expõe um socket NDJSON em `HERDR_SOCKET_PATH`, schema versionado,
  snapshot, subscriptions e métodos para agent/pane/tab/worktree. A integração
  Pi já usa esse socket para reportar estado; portanto a extensão não precisa
  executar ou fazer parsing do CLI para o fluxo normal.

## Abordagem

### 1. Transformar o repositório em pacote Pi híbrido

Adicionar manifest, toolchain TypeScript e entrypoint da extensão, mantendo a
skill como recurso do mesmo pacote. `pi install <diretório|git|npm>` deverá
instalar extensão e skill juntas; `--extension` e `--skill` continuarão úteis
para desenvolvimento local.

O entrypoint terá dois modos:

- **coordenador**: habilitado somente com `HERDR_ENV=1` e sem
  `HOLISTIC_SUBAGENT_DEPTH`; registra tools, dashboard, callbacks e cliente
  Herdr;
- **filho**: quando `HOLISTIC_SUBAGENT_DEPTH` está definido, não expõe tools de
  delegação; mantém o bloqueio de recursão, recebe sua autoridade no prompt e
  habilita o protocolo de conversa/retorno ao pai. Não haverá guard baseado em
  nomes hardcoded de tools, para permanecer compatível com a extensão que
  converte as tools do Pi para o formato Codex.

### 2. Modelar lifecycle e persistência como log de eventos

Definir tipos versionados para `Delegation`, `DelegationRequest`, recursos,
resolução de modelo, evidências e eventos. Usar uma máquina de estados única:

```text
prepared → starting → working
                    ↘ awaiting_input → working
                   ↘ ready_for_review → correcting → working
                                        ↘ accepted
qualquer estado ativo → failed
accepted | failed | estado cancelável → closing → closed
```

`ready_for_review` significa apenas que o executor entregou trabalho e
evidências. O agente principal escolherá entre revisão direta e uma nova
delegação independente de verificação. Nesse segundo caso, a delegação reviewer
terá `purpose: verification` e `reviewOf: <delegation-id>`, trabalhará sobre
commit/diff estável e produzirá seu próprio handoff; a delegação original
permanece `ready_for_review` com a relação registrada. Somente o pai pode
aceitar a original ou enviá-la para `correcting`; o reviewer nunca promove o
estado diretamente.

`degradedCapability` será metadado da resolução, não estado de lifecycle.
Transições inválidas serão rejeitadas e todas as operações mutantes serão
serializadas por delegation ID e idempotentes.

Após cada transição, a extensão gravará um snapshot/evento customizado na
sessão Pi com `pi.appendEntry`. Em `session_start` e `session_tree`, reconstruirá
somente o estado da branch ativa e reconciliará recursos ainda existentes com
`session.snapshot` do Herdr. Assim a mesma sessão Pi pode ser retomada sem um
banco global paralelo.

Cada pane/workspace criado receberá metadata Herdr com delegation ID, parent
session ID e ownership. Essa marca permite detectar recursos órfãos após crash
e impede remover recursos que a extensão não criou.

### 3. Integrar diretamente ao socket versionado do Herdr

Implementar um cliente NDJSON com request IDs, timeout, cancelamento,
reconexão limitada, validação de respostas e handshake de protocol/schema.
Consumir os métodos `session.snapshot`, `agent.start`, `pane.*`, `tab.*`,
`worktree.*`, `events.subscribe` e metadata, sempre tratando IDs retornados
como opacos.

Fluxo de criação:

1. validar ambiente, request, autoridade e política de modelo;
2. registrar `prepared` antes de criar qualquer recurso;
3. materializar pane, tab ou worktree e registrar imediatamente cada recurso;
4. iniciar Pi com `agent.start`, usando `argv` e `env` estruturados, sem shell
   quoting e sem prompt one-shot;
5. injetar depth, parent pane/session, delegation ID, callback token e política
   de autoridade do filho;
6. aguardar eventos de estado e uma confirmação única de TUI pronta;
7. enviar o brief com `pane.send_input` e confirmar `working`;
8. manter subscription para mudança de estado, saída/fechamento inesperado e
   recursos removidos, sem polling.

Pane será o padrão; tab será usado para trabalho visualmente longo; worktree
para mutações concorrentes ou snapshot estável. O adaptador esconderá as
diferenças de criação e cleanup, mas preservará a topologia no registro.

### 4. Separar eventos de infraestrutura de eventos semânticos

Mudanças Herdr (`idle`, `working`, `done`, pane fechado, processo encerrado)
atualizam saúde e lifecycle operacional. Conclusão e bloqueio continuam sendo
eventos explícitos do filho:

- `[HOLISTIC_QUESTION]` → registra uma dúvida não bloqueante e mantém o estado
  atual enquanto o filho continua qualquer trabalho seguro;
- `[HOLISTIC_INPUT_REQUIRED]` → `awaiting_input`;
- `[HOLISTIC_HANDOFF_READY]` → `ready_for_review`.

Cada pergunta terá um question ID. O texto completo, contexto, opções e impacto
ficará no pane filho; o sinal curto apenas despertará o pai. Para dúvida não
bloqueante, o pai pode responder enquanto o filho trabalha e a mensagem entra
como steering/follow-up. Quando a resposta for indispensável, o filho usará
`INPUT_REQUIRED`, encerrará o turno e aguardará em `awaiting_input`. O pai
também poderá iniciar conversas e pedir esclarecimentos a qualquer momento por
`holistic_send`, sempre reutilizando a mesma sessão.

O callback passará `delegation`, `pane` e um token aleatório injetado no filho.
O hook Pi `input` reconhecerá e validará o sinal, persistirá a transição e
transformará a mensagem em um aviso curto e legível para despertar o agente
principal. Sinais inválidos serão tratados como texto comum e nunca poderão
alterar o registro.

O handoff completo continuará no pane filho. A operação de inspeção esperará o
turno terminar, fará uma leitura única do pane e retornará status, output,
recursos e checks do workspace. Status Herdr ou resumo do filho nunca será
tratado como aceite técnico.

### 5. Expor a mesma camada de serviço ao agente e ao usuário

Registrar tools pequenas e orientadas a ações observáveis:

- `holistic_create` — validar request, resolver modelo e lançar delegação;
- `holistic_list` — listar estado resumido e divergências de reconciliação;
- `holistic_inspect` — ler handoff/saúde/evidências sem aceitar;
- `holistic_send` — responder uma pergunta/input ou enviar dúvida,
  correção/follow-up na mesma sessão;
- `holistic_manage` — focar, aceitar, marcar falha, encerrar ou limpar.

As tools usarão schemas estritos, resultados estruturados e
`executionMode: "sequential"` nas mutações. `holistic_create` não fará fallback
degradado silencioso: retornará a melhor alternativa e exigirá uma nova chamada
com aceite explícito quando somente capacidade inferior estiver disponível.

Adicionar `/holistic` como dashboard interativo, usando a UI do Pi para listar
delegações e executar as mesmas operações de abrir/focar, inspecionar,
responder, corrigir, aceitar, encerrar e limpar. Um status discreto no footer
mostrará contagens de working/input/review; não haverá monitoramento por widget
que faça polling.

### 6. Tornar a política de modelos estruturada e única

Substituir a duplicação entre tabela e comandos por um arquivo de política
versionado. A skill classificará e enviará:

- capacidade mínima orientada à forma da tarefa: `bounded`, `scoped`,
  `cross_cutting` ou `high_agency`, indo de trabalho localizado, explícito e
  pouco agêntico até missões amplas, incertas e de alta autonomia — sem usar
  preço como proxy de capacidade;
- esforço canônico: somente `low`, `medium` ou `high`;
- requisitos técnicos: contexto, modalidades, tools/grounding e harness;
- limites opcionais de custo/latência;
- requisito de independência entre as famílias/provedores permitidos.

O resolver eliminará candidatos incompatíveis, aplicará capacidade mínima e
independência, traduzirá esforço para o thinking suportado e ordenará por
preferência/custo/latência. Disponibilidade virá de
`ctx.modelRegistry.getAvailable()`/`find()`, enquanto contexto e modalidades
virão dos metadados do próprio modelo. O resultado registrará candidato,
alternativas, tradução de thinking e qualidade/degradação.

A allowlist aceitará exclusivamente modelos dos providers `openai-codex` e
`deepseek`. Independência, quando solicitada, escolherá outro provider entre
esses dois (ou falhará explicitamente se nenhum candidato compatível estiver
disponível); nunca introduzirá um terceiro provider como fallback.

`skills/holistic-subagents/references/model-selection.md` passará a explicar a classificação e será
validado contra a política. `skills/holistic-subagents/references/model-commands.md` será removido: a
extensão construirá `argv` diretamente da resolução, eliminando uma segunda
fonte de verdade operacional.

### 7. Reforçar autoridade, isolamento e cleanup

Suportar três modos explícitos:

- `read_only`: declarar a restrição no brief/system prompt, registrar baseline
  do checkout e verificar side effects no Git após cada turno/handoff;
- `controlled_mutation`: compartilhar checkout somente com ownership de paths,
  declarar os limites no brief e conferir o diff contra os paths autorizados no
  handoff;
- `isolated_mutation`: criar worktree/branch própria e aplicar as mesmas
  fronteiras declaradas e auditoria dentro dela.

Prompt é suficiente como política comportamental, mas não será descrito como
sandbox. Em vez de interceptar `write`, `edit`, `bash` ou nomes convertidos pela
extensão Codex, o pacote combinará instrução explícita, baseline/diff/status,
ownership e isolamento por worktree. Se uma tarefa exigir garantia forte de
read-only, o plano exigirá um sandbox de filesystem externo como precondição;
não fingirá obter essa garantia por matching de tool names. O bloqueio de
delegação recursiva continua estrutural porque as tools coordenadoras nem serão
registradas na sessão filha.

Cleanup seguirá o ledger em ordem reversa, será repetível e verificará Git
antes de remover worktree/branch. Nunca usará force por padrão, nunca fechará
recursos sem metadata/ownership compatível e não confundirá `accepted` com
“integrado”. Trabalho sujo, commits não preservados ou divergência de ownership
interromperão cleanup e exigirão decisão explícita de preservar/integrar ou
descartar.

## Arquivos a modificar

### Pacote e entrypoint

- `package.json` — metadata `pi-package`, recursos `extensions`/`skills`,
  scripts e peer/dev dependencies.
- `tsconfig.json` e `vitest.config.ts` — typecheck e testes Node.
- `extensions/holistic-subagents.ts` — composição da extensão, modos pai/filho,
  hooks Pi, tools, comando e shutdown.

### Núcleo novo

- `src/domain/types.ts` — contratos versionados de delegação, política,
  recursos, eventos e resultados.
- `src/domain/state-machine.ts` — transições e invariantes.
- `src/domain/store.ts` — append/rebuild pela branch da sessão Pi.
- `src/domain/service.ts` — casos de uso compartilhados por tools e dashboard.
- `src/herdr/client.ts` — transporte NDJSON, handshake, requests e subscription.
- `src/herdr/topologies.ts` — pane/tab/worktree, startup e metadata de ownership.
- `src/herdr/reconcile.ts` — cruzamento entre registro e snapshot/eventos.
- `src/models/policy.json` e `src/models/resolve.ts` — fonte única e resolução.
- `src/protocol/brief.ts` e `src/protocol/callback.ts` — brief, perguntas,
  token, correlação e sinais.
- `src/security/authority.ts` — declaração de autoridade, baseline, auditoria
  de paths/Git e requisitos de sandbox, sem dependência de nomes de tools.
- `src/pi/tools.ts`, `src/pi/dashboard.ts` e `src/pi/status.ts` — superfícies do
  agente e do usuário.

### Testes novos

- `tests/domain/*.test.ts` — máquina de estados, event log e idempotência.
- `tests/herdr/*.test.ts` — socket fake, protocolo, topologias, reconexão e
  reconciliação.
- `tests/models/*.test.ts` — filtros, thinking, independência e degradação.
- `tests/protocol/*.test.ts` — perguntas bloqueantes/não bloqueantes, callbacks
  válidos/inválidos e montagem do brief.
- `tests/security/*.test.ts` — recursão, auditoria de paths, detecção de side
  effects e cleanup.
- `tests/e2e/*.test.ts` e fixtures — cenários reais em repositório descartável.

### Skill, referências e validação

- `skills/holistic-subagents/SKILL.md` — manter decisão/brief/aceite e trocar comandos manuais pelas tools
  da extensão; documentar fallback manual somente para troubleshooting.
- `skills/holistic-subagents/references/delegation-contract.md` — novo envelope, token e return shape.
- `skills/holistic-subagents/references/herdr-operations.md` — contrato socket/topologias e diagnóstico.
- `skills/holistic-subagents/references/model-selection.md` — classificação conceitual ligada à política.
- `skills/holistic-subagents/references/model-commands.md` — remover após migração para `argv` estruturado.
- `skills/holistic-subagents/references/worktrees-and-safety.md` — enforcement, ledger, integração e
  cleanup idempotente.
- `scripts/validate.py` — manifest, schemas, política, links, compatibilidade Pi
  e protocolo Herdr.
- `README.md` — instalação como pacote híbrido, uso por agente e `/holistic`.
- `TEST_RESULTS.md` — substituir/complementar testes manuais pelo novo E2E.

## Reuso

- Critérios de delegação, recursion guard e responsabilidade final de
  `skills/holistic-subagents/SKILL.md`.
- Campos e exemplos de brief de `skills/holistic-subagents/references/delegation-contract.md`.
- Startup interativo, readiness, follow-up e semântica event-driven de
  `skills/holistic-subagents/references/herdr-operations.md`.
- Allowlist inicial e observações empíricas de
  `skills/holistic-subagents/references/model-selection.md`/`skills/holistic-subagents/references/model-commands.md`.
- Ownership, validação proporcional e ordem de cleanup de
  `skills/holistic-subagents/references/worktrees-and-safety.md`.
- Cenários e regressões reais documentados em `TEST_RESULTS.md`, especialmente
  startup antes da TUI, side effects read-only, callback e anti-polling.
- Transporte socket e hooks lifecycle comprovados pela extensão instalada
  `herdr-agent-state.ts`; APIs nativas `input`, `appendEntry`, `modelRegistry`,
  `setStatus`, `custom` e `registerTool` do Pi.

## Etapas

- [x] 1. Criar o manifest híbrido, toolchain TypeScript e smoke test de carga
      conjunta da extensão e da skill.
- [x] 2. Implementar contratos, máquina de estados, snapshots/event log e testes
      de transição, retomada de branch e idempotência.
- [x] 3. Implementar cliente Herdr socket com handshake, requests, subscription,
      cancelamento e testes contra servidor fake/schema atual.
- [x] 4. Implementar pane, tab e worktree com startup interativo, readiness,
      metadata e ledger persistido antes/depois de cada side effect.
- [x] 5. Implementar política estruturada OpenAI/DeepSeek e resolver
      determinístico usando o model registry do Pi, incluindo independência e
      fallback degradado.
- [x] 6. Implementar perguntas pai/filho, callback autenticado, hook `input`,
      reconciliação de status/recursos e detecção de crash sem polling.
- [x] 7. Implementar autoridade declarativa compatível com as tools Codex,
      guard estrutural de recursão, auditoria de paths/Git e cleanup
      conservador/idempotente.
- [x] 8. Registrar as cinco tools e renderização estruturada, todas apoiadas na
      mesma camada de serviço.
- [x] 9. Implementar `/holistic`, foco/ações interativas e status resumido no
      footer, com fallback adequado em modo sem UI.
- [x] 10. Migrar a skill e referências, remover comandos/model table duplicados
      e ampliar `scripts/validate.py`.
- [x] 11. Executar testes unitários, integração socket, E2E real, instalação
      local/global e documentar resultados e limitações.

## Verificação

### Automatizada

- `npm run typecheck`, `npm test` e `npm run lint` (se configurado).
- `python scripts/validate.py`, incluindo manifest, links, policy/schema,
  callback markers e compatibilidade com o protocol version do Herdr.
- Testes com socket fake para respostas fragmentadas, IDs fora de ordem,
  timeout, abort, disconnect/reconnect, evento duplicado e recurso ausente.
- Testes de propriedade/tabela para todas as transições de estado e combinações
  capacidade/esforço/requisitos/fallback.

### E2E em ambiente descartável

- Tarefa trivial sem delegação e recursion guard em sessão filha.
- Pane read-only com follow-up, retomada da mesma sessão e detecção de side
  effect inesperado.
- Tab longa sem foco e callback após o pai encerrar o turno.
- Duas mutações paralelas em worktrees distintas, ownership sem sobreposição,
  commits preservados e integração validada.
- Dúvida não bloqueante do filho durante trabalho, resposta do pai por steering
  e continuidade sem mudar para `awaiting_input`.
- `[HOLISTIC_INPUT_REQUIRED]` → resposta → retomada →
  `[HOLISTIC_HANDOFF_READY]`, incluindo token inválido e callback duplicado.
- Handoff revisado diretamente pelo pai e, em outro cenário, por uma delegação
  reviewer vinculada; achado enviado ao executor original, correção na mesma
  sessão, nova inspeção e aceite exclusivo pelo pai.
- Modelo indisponível, requisito incompatível, alternativa equivalente e
  alternativa degradada que não inicia sem opt-in.
- Crash do filho, pane removido externamente, restart do pai, reconciliação por
  snapshot/metadata e recuperação de órfãos.
- Cleanup repetido, worktree suja, branch não integrada e tentativa de remover
  recurso não pertencente à delegação.
- Instalação por `pi install` e execução local por `--extension` + `--skill`,
  confirmando que extensões/skills/context files normais do filho permanecem
  carregados.

### Critérios de aceite

- Nenhum fluxo normal depende de polling, parsing de terminal para lifecycle ou
  montagem manual de comandos Herdr.
- Uma delegação sobrevive a reload/resume e mantém sessão filha reutilizável.
- Todo recurso criado é registrado e somente recursos com ownership compatível
  podem ser limpos.
- O principal recebe eventos, mas só `holistic_manage accept` após inspeção
  registra aceite; conclusão do filho nunca equivale a validação.
- Política de modelos e launch argv têm uma única fonte estruturada e nenhum
  fallback fora da allowlist OpenAI/DeepSeek; thinking fica limitado a `low`,
  `medium` e `high`.
