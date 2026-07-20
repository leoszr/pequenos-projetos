# Operações essenciais do Herdr

Use esta referência depois que a skill principal decidir que delegar vale o
custo. O CLI instalado é a autoridade. Se a sintaxe puder ter mudado, consulte:

```bash
herdr --help
herdr pane
herdr wait
pi --help
```

Nunca execute `herdr` sem subcomando; isso abre ou anexa a TUI.

## Preconditions

```bash
test "${HERDR_ENV:-}" = 1
test -z "${HOLISTIC_SUBAGENT_DEPTH:-}"
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
herdr pane current --current
```

Se `HERDR_ENV` não for `1`, continue a tarefa diretamente. Se
`HOLISTIC_SUBAGENT_DEPTH` estiver definido, esta já é uma sessão auxiliar e não
deve delegar novamente.

Trate IDs como valores opacos. Leia-os do JSON retornado pelo Herdr; nunca os
derive de exemplos, labels, ordem visual ou IDs de outros recursos.

## Criar o pane padrão

Inspecione o layout:

```bash
herdr pane layout --pane "$HERDR_PANE_ID"
```

Divida um pane largo para a direita e um pane estreito ou alto para baixo. Não
roube o foco do agente principal:

```bash
herdr pane split --current \
  --direction right \
  --cwd "$PWD" \
  --env HOLISTIC_SUBAGENT_DEPTH=1 \
  --env HOLISTIC_PARENT_PANE_ID="$HERDR_PANE_ID" \
  --no-focus
```

Leia `result.pane.pane_id` do JSON e registre o ID. Troque `right` por `down`
quando o layout pedir.

Para tabs, worktrees, mutações concorrentes e cleanup avançado, consulte
[worktrees-and-safety.md](worktrees-and-safety.md).

## Iniciar Pi interativamente

Escolha modelo e thinking em
[model-selection.md](model-selection.md). Consulte
[model-commands.md](model-commands.md) apenas se precisar do comando exato.

Renomeie o pane e inicie somente Pi:

```bash
herdr pane rename <pane-id> "<tarefa> · Pi"

herdr pane run <pane-id> \
  'HOLISTIC_SUBAGENT_DEPTH=1 \
   HOLISTIC_PARENT_PANE_ID="<parent-pane-id>" \
   pi \
    --model "<provider/model permitido>" \
    --thinking "<nível da tabela>" \
    --name "<tarefa>" \
    --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."'
```

Não envie a tarefa como argumento do executável. A sessão deve abrir primeiro
e permanecer interativa para follow-ups.

## Esperar e enviar o brief

Inspecione antes de esperar:

```bash
herdr pane get <pane-id>
herdr pane read <pane-id> --source recent-unwrapped --lines 80
```

Espere Pi ficar disponível:

```bash
herdr wait agent-status <pane-id> --status idle --timeout 60000
```

O primeiro `idle` pode ocorrer quando o processo Pi já foi detectado, mas a TUI
ainda carrega extensions e skills. Antes de enviar o brief, confirme que o
prompt Pi está visível:

```bash
herdr pane read <pane-id> --source visible --lines 60
```

Se ainda aparecer somente o comando no shell, espere a tela inicial do Pi. Um
check possível na versão atual é:

```bash
herdr wait output <pane-id> \
  --match "Welcome back!" \
  --source visible \
  --lines 60 \
  --timeout 90000
```

Envie o brief autocontido e confirme execução:

```bash
herdr pane run <pane-id> "<brief autocontido>"
herdr wait agent-status <pane-id> --status working --timeout 30000
```

Se um wait expirar, inspecione `pane get` e `pane read` antes de agir. Só envie
Enter manualmente se o texto estiver visivelmente parado no editor.

## Lifecycle orientado a eventos

Depois de confirmar `working`, o caminho padrão é parar a supervisão ativa. O
filho enviará `[HOLISTIC_INPUT_REQUIRED]` ou `[HOLISTIC_HANDOFF_READY]` ao pane
do pai com `herdr pane run`. Essa mensagem entra como novo input e desperta o
pai.

Se o pai não tiver trabalho próprio independente para fazer, ele deve encerrar
o turno atual. Não mantenha tool calls abertos somente para observar progresso.
Não consulte periodicamente:

- `herdr pane get` ou `herdr pane read`;
- processos FFmpeg, testes ou servidores;
- tamanho e timestamp de arquivos;
- sessões de `exec_command` com sequências de `write_stdin` curtas.

Depois do sinal, confirme que o turno do filho terminou em `idle` ou `done` e
leia o pane uma vez. Inspecionar artefatos para validar um handoff é obrigatório
e não conta como polling.

Inspeção durante o trabalho só é aceitável quando houver um checkpoint de risco
definido antes do dispatch — por exemplo, validar uma amostra antes de um render
de várias horas — ou quando surgir evidência concreta que exija intervenção.
Curiosidade sobre progresso não é checkpoint.

## Espera síncrona opcional

Use espera síncrona somente quando o pai não puder encerrar o turno e aguardar o
callback. Faça uma única espera com timeout longo, limitado e proporcional à
tarefa. Dez minutos é um bom padrão para trabalho comum; tarefas sabidamente
longas podem usar um timeout maior.

O status esperado depende de onde o pane está:

- `idle`: normalmente, filho no tab ativo;
- `done`: normalmente, filho em tab ou workspace de background.

Exemplo para um filho no tab ativo:

```bash
herdr wait agent-status <pane-id> --status idle --timeout 600000
```

Use `--status done` no contexto de background. Como foco e visibilidade podem
mudar, se o wait expirar faça uma única inspeção antes de decidir se espera de
novo:

```bash
herdr pane get <pane-id>
herdr pane read <pane-id> --source recent-unwrapped --lines 160
```

O timeout é um health check para detectar crash, prompt externo, integração
quebrada ou progresso travado; não é intervalo de polling.

Se `exec_command` devolver uma sessão ainda em execução, aguarde essa sessão
com um único `write_stdin` longo. Nunca use loops ou chamadas repetidas com
`yield_time_ms=1000` para simular espera.

### Vários filhos

Não abra um `exec_command` independente para cada filho e depois consulte todas
as sessões periodicamente. Faça fan-in dos eventos em um único processo shell
e deixe `wait -n` retornar quando qualquer filho terminar um turno:

```bash
set -euo pipefail
pids=()
for pane in <pane-id-1> <pane-id-2> <pane-id-3>; do
  herdr wait agent-status "$pane" --status done --timeout 1800000 &
  pids+=("$!")
done
cleanup_waits() {
  kill "${pids[@]}" 2>/dev/null || true
  wait "${pids[@]}" 2>/dev/null || true
}
trap cleanup_waits EXIT
wait -n
```

Use `idle` em vez de `done` para filhos no tab ativo. O JSON do evento vencedor
contém `pane_id`. Depois de tratar esse filho, rearme uma única espera para os
filhos restantes. O callback continua sendo a autoridade; este fan-in é apenas
fallback síncrono.

Se `agent_status` ficar `unknown`, confirme `herdr integration status` e leia o
pane diretamente antes de concluir que a sessão falhou.

Não dependa de `blocked` para detectar espera por informação. Em testes, o
modal de `ask_user` permaneceu como `working`. O contrato exige que o filho
evite esse modal, sinalize `[HOLISTIC_INPUT_REQUIRED]` e encerre o turno; assim
o wait do pai retorna em `idle` ou `done`. Se uma sessão antiga ficar presa em
um modal, leia o pane e responda com `herdr pane send-keys`.

## Follow-ups

Use sempre o mesmo pane:

```bash
herdr pane run <pane-id> "<resposta, correção ou próximo pedido>"
```

Mantenha o follow-up estreito e baseado em evidência. Não reenvie todo o brief
se a sessão ainda preserva contexto.

## Sinalizar dúvida ou conclusão ao agente principal

O pane filho recebe `HOLISTIC_PARENT_PANE_ID` do coordenador. Quando uma dúvida
impedir progresso seguro, ele deve registrar no próprio pane a pergunta
completa, impacto e opções, enviar o sinal e encerrar o turno:

```bash
if [ -n "${HOLISTIC_PARENT_PANE_ID:-}" ]; then
  herdr pane run "$HOLISTIC_PARENT_PANE_ID" \
    "[HOLISTIC_INPUT_REQUIRED] child=$HERDR_PANE_ID task=<resumo-curto>. Espere o child ficar idle/done, leia o pane e responda nele."
fi
```

Não pergunte antes de investigar o que for possível nem interrompa trabalho
independente que ainda seja seguro. Não use `ask_user` para esperar pelo pai.

Quando o trabalho e a evidência estiverem prontos, execute:

```bash
if [ -n "${HOLISTIC_PARENT_PANE_ID:-}" ]; then
  herdr pane run "$HOLISTIC_PARENT_PANE_ID" \
    "[HOLISTIC_HANDOFF_READY] child=$HERDR_PANE_ID task=<resumo-curto>. Espere o child ficar idle/done e leia o pane antes de agir."
fi
```

Esse comando envia texto e Enter ao Pi principal. Se ele estiver trabalhando,
a mensagem entra na fila de steering e será processada após o tool call atual.
Por isso:

- envie somente uma notificação curta, não o handoff completo;
- envie `[HOLISTIC_INPUT_REQUIRED]` uma vez por episódio de bloqueio;
- envie `[HOLISTIC_HANDOFF_READY]` uma única vez, após concluir validações;
- use apenas o parent ID injetado; não procure nem invente outro ID;
- mantenha resultado, evidência e limitações no pane filho;
- encerre o turno depois do sinal para liberar o wait do principal;
- o principal deve esperar `idle` ou `done` antes de ler o pane;
- a mensagem é um sinal, não prova de conclusão.

Se o principal já encerrou o turno, a mensagem o desperta diretamente. Essa é
a operação normal e preferida; não é necessário polling paralelo para garantir
o recebimento.

Não use `herdr agent send`: ele escreve texto literal sem Enter e não submete a
mensagem. `herdr notification show` avisa o usuário, mas não entrega contexto ao
agente principal.

## Fechar pane comum

Feche somente panes criados por este fluxo e apenas depois de preservar o
resultado:

```bash
herdr pane close <pane-id>
```

Use o procedimento de cleanup em
[worktrees-and-safety.md](worktrees-and-safety.md) quando houver tab, workspace,
worktree, branch, commits ou artefatos associados.
