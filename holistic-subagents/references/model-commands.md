# Comandos dos modelos permitidos

Carregue esta referência somente quando precisar montar o comando de lançamento.
Todos os exemplos iniciam uma sessão Pi interativa normal, com extensions,
skills, context files e demais recursos configurados no Pi.

O brief deve ser enviado depois com `herdr pane run`; não o acrescente como
argumento one-shot do executável Pi.

Cada comando inclui uma instrução de sistema contra delegação recursiva. O env
`HOLISTIC_SUBAGENT_DEPTH=1` continua como segunda camada de proteção.

Os comandos presumem que o pane herdou `HOLISTIC_PARENT_PANE_ID`. Em root panes
de worktree, que não herdam esse env, acrescente antes de `pi`:

```bash
HOLISTIC_PARENT_PANE_ID="<parent-pane-id>"
```

## Luna low — microtarefa mecânica

```bash
HOLISTIC_SUBAGENT_DEPTH=1 pi \
  --model openai-codex/gpt-5.6-luna \
  --thinking low \
  --name "<tarefa>" \
  --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."
```

## Luna medium — tarefa pequena e explícita

```bash
HOLISTIC_SUBAGENT_DEPTH=1 pi \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --name "<tarefa>" \
  --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."
```

## Luna high — tarefa pequena e bem definida

```bash
HOLISTIC_SUBAGENT_DEPTH=1 pi \
  --model openai-codex/gpt-5.6-luna \
  --thinking high \
  --name "<tarefa>" \
  --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."
```

## DeepSeek V4 Flash high — alternativa para tarefa pequena e bem definida

```bash
HOLISTIC_SUBAGENT_DEPTH=1 pi \
  --model deepseek/deepseek-v4-flash \
  --thinking high \
  --name "<tarefa>" \
  --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."
```

## Terra low — tarefa média e previsível

```bash
HOLISTIC_SUBAGENT_DEPTH=1 pi \
  --model openai-codex/gpt-5.6-terra \
  --thinking low \
  --name "<tarefa>" \
  --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."
```

## Terra medium — tarefa média ou com muitas etapas

```bash
HOLISTIC_SUBAGENT_DEPTH=1 pi \
  --model openai-codex/gpt-5.6-terra \
  --thinking medium \
  --name "<tarefa>" \
  --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."
```

## DeepSeek V4 Pro high — alternativa para tarefa média ou com muitas etapas

```bash
HOLISTIC_SUBAGENT_DEPTH=1 pi \
  --model deepseek/deepseek-v4-pro \
  --thinking high \
  --name "<tarefa>" \
  --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."
```

## Terra high — tarefa média difícil ou cross-cutting

```bash
HOLISTIC_SUBAGENT_DEPTH=1 pi \
  --model openai-codex/gpt-5.6-terra \
  --thinking high \
  --name "<tarefa>" \
  --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."
```

## Sol low — tarefa longa e clara

```bash
HOLISTIC_SUBAGENT_DEPTH=1 pi \
  --model openai-codex/gpt-5.6-sol \
  --thinking low \
  --name "<tarefa>" \
  --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."
```

## Sol medium — tarefa longa com complexidade ou incerteza relevante

```bash
HOLISTIC_SUBAGENT_DEPTH=1 pi \
  --model openai-codex/gpt-5.6-sol \
  --thinking medium \
  --name "<tarefa>" \
  --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."
```

## Sol high — tarefa longa de máxima dificuldade ou escalada fundamentada

```bash
HOLISTIC_SUBAGENT_DEPTH=1 pi \
  --model openai-codex/gpt-5.6-sol \
  --thinking high \
  --name "<tarefa>" \
  --append-system-prompt "You are an auxiliary Pi session. Do not create or control other agent sessions."
```
