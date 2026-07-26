# Política de seleção de modelos

A fonte única concreta é `src/models/policy.json`. Ela permite somente OpenAI
Codex e DeepSeek. IDs de modelo ficam internos: a tool recebe capacidade mínima
e o resolver escolhe o menor modelo suficiente entre os disponíveis.

## Capacidade exposta

- `bounded`: trabalho localizado, explícito e pouco agêntico; esforço automático
  `low`;
- `scoped`: missão delimitada, multi-etapas e observável; esforço `medium`;
- `cross_cutting`: vários módulos, exploração ampla ou ambiguidade material;
  esforço `medium`;
- `high_agency`: missão ampla, longa e autônoma; esforço `high`.

Uma etapa trivial ainda deve permanecer com o agente principal. Capacidade mede
demanda mínima do filho, não cargo, preço ou quantidade isolada de arquivos.

## Reasoning effort

`effort=auto` ou omitir o campo usa o padrão da capacidade. Override:

- `low`: procedimento conhecido e poucas decisões;
- `medium`: ponto de partida equilibrado para trabalho multi-etapas;
- `high`: ambiguidade, hipóteses concorrentes, risco ou validação difícil.

O resolver traduz o esforço para o nível nativo suportado e registra quando a
tradução não é exata. DeepSeek, por exemplo, eleva `low` e `medium` para `high`.
Mais thinking não é garantia de qualidade: suba apenas quando a tarefa ou evals
mostrarem ganho.

## Worker versus reviewer

A policy separa elegibilidade por propósito:

- execução `bounded|scoped`: Luna normalmente vence; Flash permanece
  alternativa;
- execução `cross_cutting`: DeepSeek V4 Pro vence; GPT-5.6 Terra é fallback;
- execução `high_agency`: GPT-5.6 Sol;
- `purpose=verification`: somente GPT-5.6 Sol, com esforço automático `high`.

DeepSeek é worker, não reviewer. `allowDegraded` nunca torna um modelo inelegível
para verification em reviewer. Para review independente, use contexto limpo,
brief adversarial, artefato estável e critérios objetivos; diversidade de
provider não compensa um reviewer pior.

## Filtros e ordem

1. disponibilidade no `ctx.modelRegistry`;
2. elegibilidade `execution|verification`;
3. contexto, modalidades, tools e harness obrigatórios;
4. provider/família evitado quando solicitado;
5. menor capacidade igual ou superior à solicitada;
6. preferência local e limites independentes de custo/latência;
7. tradução de thinking.

Se somente candidato de capacidade inferior estiver disponível, a extensão
retorna alternativas degradadas e exige `allowDegraded=true` explícito. Nunca
há fallback fora de OpenAI Codex/DeepSeek nem entre propósitos inelegíveis.

## Base da política

- [OpenAI — Model guidance](https://developers.openai.com/api/docs/guides/latest-model):
  `medium` como baseline, `low` para latência e níveis altos somente com ganho
  medido; Luna/Terra/Sol como eficiente/equilibrado/frontier.
- [DeepSeek — Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode):
  thinking padrão `high`, com `low`/`medium` mapeados para `high`.
- [OpenAI — Practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/):
  estabelecer baseline com modelo capaz, criar evals e só então reduzir custo e
  latência com modelos menores.

O rank que prioriza Pro sobre Terra é uma preferência operacional deliberada
para workers. Continue comparando sucesso, completude, evidências, tokens,
latência, custo, chamadas e retries em tarefas representativas.
