# Integração Herdr

Esta referência é diagnóstico e fallback. No fluxo normal, use as tools
`holistic_*`; a extensão conversa diretamente com o socket NDJSON indicado por
`HERDR_SOCKET_PATH`.

## Preconditions

```bash
test "${HERDR_ENV:-}" = 1
test -z "${HOLISTIC_SUBAGENT_DEPTH:-}"
herdr integration status
herdr api snapshot
herdr api schema --json
```

A extensão exige protocol compatível, lê IDs opacos do snapshot/respostas e
assina eventos. Não derive IDs de labels ou layout.

## Operações materializadas

- pane: `pane.split` no pane pai, seguido de `agent.start` no pane retornado;
- tab: `tab.create` e `agent.start` no root pane retornado;
- worktree: `worktree.create`, instalação do ambiente no shell e `agent.start`
  no root pane retornado;
- startup: `agent.start` aguarda prontidão, uma barreira limitada confirma o
  session hook do Pi, e `agent.prompt` envia o brief atomicamente aguardando
  `working`;
- runtime: subscription de status e callbacks semânticos autenticados;
- cleanup: `pane.close`, `tab.close` ou `worktree.remove`, conforme o ledger.

Pi sempre inicia interativamente. O brief não é argumento one-shot. Extensões,
skills e context files normais permanecem carregados, inclusive a extensão que
converte tools para Codex.

## Sem polling

Após `holistic_create` retornar `working`, encerre supervisão ativa. Os sinais
`HOLISTIC_QUESTION`, `HOLISTIC_INPUT_REQUIRED` e `HOLISTIC_HANDOFF_READY`
despertam o pai. Não faça loops de `pane get/read`, probes de arquivos/processos
ou sequências curtas de `write_stdin(... yield_time_ms=1000)`.

Timeout de startup/request é health check. Após timeout, faça uma única
inspeção. A extensão reconcilia snapshot em resume/reload e marca pane ausente,
crash ou ownership divergente.

## Diagnóstico manual

```bash
herdr pane get <pane-id>
herdr pane read <pane-id> --source recent-unwrapped --lines 160
herdr agent wait <pane-id> --until idle --until done --timeout 600000
```

Para vários waits manuais, faça fan-in em um processo e use `wait -n`; não abra
várias sessões de shell para consultar em loop. Callbacks e follow-ups usam
`agent prompt`; `agent send-keys` fica reservado para teclas lógicas da TUI.

O CLI instalado e `herdr api schema --json` são a autoridade quando a sintaxe
ou protocol mudar.
