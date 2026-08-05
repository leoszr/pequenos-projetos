# Contrato dinâmico de delegação

Uma delegação descreve uma necessidade concreta; não atribui persona ou papel
permanente. `holistic_create` recebe os campos estruturados e a extensão monta o
brief interativo.

## Campos mínimos

- `name` e `mission`: resultado observável;
- `cwd` e contexto relevante;
- `authority.mode`, paths permitidos/proibidos;
- `acceptanceEvidence`;
- `topology`: `pane` agrupa o filho em uma tab auxiliar com até três panes;
  `tab` cria uma tab auxiliar dedicada; `worktree` cria checkout/workspace
  isolado. Nenhuma opção usa a tab do coordenador;
- `minimumCapability` e `effort=auto` ou um esforço exposto pela Política
  Efetiva;
- `reviewOf` quando revisar outro trabalho; ele infere `purpose=verification`,
  e `purpose=execution` explícito é rejeitado.

O filho deve retornar resultado, evidências, comandos executados, arquivos ou
commits e incertezas/riscos. O transcript completo do pai não é enviado por
padrão.

## Conversa pai/filho

A extensão injeta no filho:

- `HOLISTIC_PARENT_PANE_ID`;
- `HOLISTIC_DELEGATION_ID`;
- `HOLISTIC_CALLBACK_TOKEN`;
- `HOLISTIC_ARTIFACT_ROOT_ID` e `HOLISTIC_ARTIFACT_ROOT`;
- `HOLISTIC_SUBAGENT_DEPTH=1`.

Antes de sinalizar, o filho escreve no próprio pane a pergunta completa,
contexto, impacto e opções.
Cada brief ou prompt do pai informa o `cycleId` atual e o callback exato; ele
não é variável de ambiente porque muda durante a mesma Agent Session.

### Dúvida não bloqueante

Use quando o filho pode continuar trabalho independente seguro:

```bash
herdr pane run "$HOLISTIC_PARENT_PANE_ID" \
  "[HOLISTIC_QUESTION] delegation=$HOLISTIC_DELEGATION_ID pane=$HERDR_PANE_ID token=$HOLISTIC_CALLBACK_TOKEN cycle=<current-cycle-id> question=<id>"
```

O estado continua `working`. A resposta do pai enviada por `holistic_send`
entra como steering/follow-up na mesma sessão.

### Entrada obrigatória

Use quando não é seguro prosseguir. Envie uma vez e encerre o turno:

```bash
herdr pane run "$HOLISTIC_PARENT_PANE_ID" \
  "[HOLISTIC_INPUT_REQUIRED] delegation=$HOLISTIC_DELEGATION_ID pane=$HERDR_PANE_ID token=$HOLISTIC_CALLBACK_TOKEN cycle=<current-cycle-id> question=<id>"
```

A extensão autentica o callback e move a delegação para `awaiting_input`.

### Handoff pronto

Depois de concluir e validar o trabalho:

1. grave artifacts em
   `$HOLISTIC_ARTIFACT_ROOT/$HOLISTIC_DELEGATION_ID/<current-cycle-id>/`;
2. publique por arquivo temporário + rename atômico um manifest JSON com
   `protocolVersion`, `cycleId`, `summary`, `commands`, `files`, `commits`,
   `risks` e `artifacts`;
3. cada artifact referencia `id`, `rootId`, `mediaType`, `size` e `sha256`;
4. calcule SHA-256 sobre os bytes finais do manifest.

```bash
herdr pane run "$HOLISTIC_PARENT_PANE_ID" \
  "[HOLISTIC_HANDOFF_READY] delegation=$HOLISTIC_DELEGATION_ID pane=$HERDR_PANE_ID token=$HOLISTIC_CALLBACK_TOKEN cycle=<current-cycle-id> manifest=$manifest_id sha256=$manifest_sha256"
```

O filho encerra o turno e permanece disponível. O sinal registra apenas a
alegação. Claim, trabalho observado e `agent_settled` do mesmo ciclo podem
chegar em qualquer ordem. A Run só fica revisável após os três. Então o pai usa
`holistic_inspect`, que valida manifest, artifacts e autoridade; não há fallback
por transcript.

## Follow-up

O pai usa `holistic_send` com uma resposta ou pedido estreito. Para correção,
informa falha observada, comportamento esperado, limite de ownership e checks a
repetir. Cada mensagem do pai cria outro `cycleId`; perguntas do filho continuam
no ciclo ativo. Não recria a sessão nem reenvia o brief inteiro.
