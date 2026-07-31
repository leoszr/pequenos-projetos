# Política de seleção de modelos

A Política de Modelos é configuração JSON carregada no startup da extensão e em
`/reload`. O módulo TypeScript `src/models/policy.ts` concentra descoberta,
validação, resolução e erros; callers recebem um resolver já ligado à Política
Efetiva.

## Descoberta e precedência

A política usa substituição integral, nunca merge:

1. projeto confiável: `.pi/holistic-subagents/model-policy.json`;
2. global: `$PI_CODING_AGENT_DIR/holistic-subagents/model-policy.json` — por
   padrão, `~/.pi/agent/holistic-subagents/model-policy.json`.

Se nenhum arquivo existir, a extensão copia
`src/models/default-policy.json` para o caminho global. Essa criação acontece
uma única vez; atualizações do pacote nunca sobrescrevem configuração do usuário.
Uma política presente mas inválida falha explicitamente e não usa fallback.

A configuração do projeto só é lida quando o projeto está confiável no Pi.
Alterações entram em vigor na próxima sessão ou após `/reload`. Modelos
configurados mas ausentes em `ctx.modelRegistry` geram warning no startup e são
filtrados novamente ao resolver cada delegação.

## Vocabulário estável

A implementação fixa apenas conceitos usados por toda a delegação:

- capacidades: `bounded|scoped|cross_cutting|high_agency`;
- finalidades: `execution|verification`;
- níveis reconhecidos pelo Pi: `off|minimal|low|medium|high|xhigh|max`.

O JSON escolhe providers, modelos permitidos, esforços expostos, defaults,
elegibilidade, ranks e traduções `thinkingMap`. O schema da tool é derivado da
Política Efetiva por um adapter TypeBox; não repete os esforços configurados.

## Política padrão

- execução `bounded`: GPT-5.6 Luna `xhigh`;
- execução `scoped`: GPT-5.6 Luna `max`;
- execução `cross_cutting`: GPT-5.6 Terra `xhigh`;
- execução `high_agency`: GPT-5.6 Sol `medium`;
- `purpose=verification`: somente GPT-5.6 Sol `medium`.

Na política padrão, Luna nunca é lançada em `medium`: pedidos menores são
elevados para `xhigh`. Terra é normalizada para `xhigh`; Sol é limitado a
`low|medium`.

## Filtros e ordem

1. disponibilidade no `ctx.modelRegistry`;
2. elegibilidade `execution|verification`;
3. contexto, modalidades, tools e harness obrigatórios;
4. família evitada quando solicitado;
5. menor capacidade igual ou superior à solicitada;
6. preferência local e limites independentes de custo/latência;
7. tradução de thinking pela Política Efetiva.

Se somente candidato de capacidade inferior estiver disponível, a extensão
retorna alternativas degradadas e exige `allowDegraded=true` explícito. A
allowlist vem do JSON; não existe fallback para modelo ausente da Política
Efetiva nem entre finalidades inelegíveis.

## Base da política padrão

- [OpenAI — Model guidance](https://developers.openai.com/api/docs/guides/latest-model):
  esforço deve ser ajustado com evals;
- [OpenAI — GPT-5.6 price-performance](https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/):
  Sol resolve incerteza e planeja; Luna executa mudanças bem especificadas,
  testes e avaliações em volume;
- [OpenAI — Practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/):
  estabelecer baseline, criar evals e só então otimizar custo e latência.

Continue comparando sucesso, completude, evidências, tokens, latência, custo,
chamadas e retries em tarefas representativas antes de editar a política.
