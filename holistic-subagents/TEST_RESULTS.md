# Resultados de teste

## Compatibilidade Herdr 0.7.5

Auditoria em 2026-07-21 contra o CLI/schema local (protocol 17), documentação
oficial e release v0.7.5. O fluxo real `pane.split -> agent.start ->
agent.prompt` iniciou Pi, observou `working` e removeu o pane criado. A suíte
automatizada completa também passou após a migração.

Data: 2026-07-20

Ambiente: Pi 0.80.x, Herdr 0.7.4/protocol 16, repositório Git real e sessões Pi
interativas sem foco. Todos os panes, tabs, workspaces e worktrees criados pelo
E2E foram removidos ao final.

## Automação

- `npm run typecheck`: passou;
- `npm test`: 11 arquivos, 37 testes, todos passaram;
- cobertura exercitada: state machine, event log, socket NDJSON, topologias,
  resolver, callbacks, reconciliação, autoridade, cleanup e service;
- `python scripts/validate.py`: passou para manifest híbrido, links, três
  callbacks, Herdr schema/protocol e cinco modelos OpenAI/DeepSeek;
- `npm pack --dry-run`: 25 arquivos de runtime/documentação, sem `node_modules`;
- `npm audit --omit=dev`: nenhuma vulnerabilidade de runtime.

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
