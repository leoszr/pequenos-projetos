# Contrato dinâmico de delegação

Uma delegação descreve uma necessidade concreta; não atribui persona ou papel
permanente. `holistic_create` recebe os campos estruturados e a extensão monta o
brief interativo.

## Campos mínimos

- `name` e `mission`: resultado observável;
- `cwd` e contexto relevante;
- `authority.mode`, paths permitidos/proibidos;
- `acceptanceEvidence`;
- `topology`;
- capacidade mínima e esforço;
- `purpose=verification` + `reviewOf` quando revisar outro trabalho.

O filho deve retornar resultado, evidências, comandos executados, arquivos ou
commits e incertezas/riscos. O transcript completo do pai não é enviado por
padrão.

## Conversa pai/filho

A extensão injeta no filho:

- `HOLISTIC_PARENT_PANE_ID`;
- `HOLISTIC_DELEGATION_ID`;
- `HOLISTIC_CALLBACK_TOKEN`;
- `HOLISTIC_SUBAGENT_DEPTH=1`.

Antes de sinalizar, o filho escreve no próprio pane a pergunta completa,
contexto, impacto e opções.

### Dúvida não bloqueante

Use quando o filho pode continuar trabalho independente seguro:

```bash
herdr pane run "$HOLISTIC_PARENT_PANE_ID" \
  "[HOLISTIC_QUESTION] delegation=$HOLISTIC_DELEGATION_ID pane=$HERDR_PANE_ID token=$HOLISTIC_CALLBACK_TOKEN question=<id>"
```

O estado continua `working`. A resposta do pai enviada por `holistic_send`
entra como steering/follow-up na mesma sessão.

### Entrada obrigatória

Use quando não é seguro prosseguir. Envie uma vez e encerre o turno:

```bash
herdr pane run "$HOLISTIC_PARENT_PANE_ID" \
  "[HOLISTIC_INPUT_REQUIRED] delegation=$HOLISTIC_DELEGATION_ID pane=$HERDR_PANE_ID token=$HOLISTIC_CALLBACK_TOKEN question=<id>"
```

A extensão autentica o callback e move a delegação para `awaiting_input`.

### Handoff pronto

Depois de concluir e validar o trabalho:

```bash
herdr pane run "$HOLISTIC_PARENT_PANE_ID" \
  "[HOLISTIC_HANDOFF_READY] delegation=$HOLISTIC_DELEGATION_ID pane=$HERDR_PANE_ID token=$HOLISTIC_CALLBACK_TOKEN"
```

O filho encerra o turno e permanece disponível. O pai usa `holistic_inspect`;
o sinal não é evidência nem aceite.

## Follow-up

O pai usa `holistic_send` com uma resposta ou pedido estreito. Para correção,
informa falha observada, comportamento esperado, limite de ownership e checks a
repetir. Não recria a sessão nem reenvia o brief inteiro.
