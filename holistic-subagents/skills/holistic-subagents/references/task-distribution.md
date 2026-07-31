# Distribuição de tarefas entre subagents

Use o agente principal como manager: ele mantém o objetivo, escolhe workers,
resolve conflitos, revisa evidências e entrega o resultado. Filhos não delegam.

## Quando delegar

Delegue somente se o ganho superar o custo de contexto e coordenação:

- linhas de investigação realmente independentes;
- especialização, ferramentas ou permissões diferentes;
- contexto grande que pode ser isolado por módulo/fonte;
- trabalho longo com handoff observável;
- verificação independente que reduz risco material.

Não delegue resposta simples, edição local curta, uma única chamada de tool ou
trabalho que exige decisões contínuas no mesmo contexto. Primeiro maximize o
agente principal; multi-agent adiciona latência, custo e falhas de coordenação.

## Como decompor

Modele dependências antes de criar filhos:

- **Paralelo:** subtarefas sem dependência e sem paths de escrita sobrepostos.
- **Sequencial:** pesquisa → plano → implementação → validação quando cada fase
  consome o resultado anterior.
- **Review:** executor termina e produz artefato estável; reviewer independente
  tenta refutar o resultado contra critérios explícitos.

Comece com o menor fan-out útil. Em comparação/pesquisa, 2–4 workers distintos
costumam cobrir perspectivas sem coordenação excessiva. Expanda somente quando
existirem novas frentes não sobrepostas e o valor justificar o custo. Nunca use
quantidade fixa como meta.

Para mutação, mantenha um único writer por path. Use worktrees para isolamento
real e integre apenas depois de revisar diff, testes e auditoria de autoridade.

## Contrato de cada worker

Inclua sempre:

1. resultado observável;
2. contexto mínimo suficiente;
3. fronteiras positivas e negativas;
4. authority e paths;
5. fontes/tools preferidas quando relevantes;
6. critérios de aceite e condição de parada;
7. formato de retorno e evidências exigidas.

Fronteiras devem diferenciar os workers. Prompts vagos produzem buscas
duplicadas e lacunas. Resultados grandes devem permanecer como artefatos; o
handoff retorna referência, resumo, comandos e riscos, evitando “telefone sem
fio” pelo manager.

## Seleção de capacidade

- `bounded`: alteração ou investigação localizada;
- `scoped`: worker normal, missão clara e verificável;
- `cross_cutting`: causa incerta, vários módulos, síntese ou review difícil;
- `high_agency`: horizonte longo, escopo amplo e ambiguidade material.

Use `effort=auto` por padrão. A policy traduz a capacidade para o perfil do
modelo: Luna `xhigh|max`, Terra `xhigh` e Sol `low|medium`. Overrides fora do
perfil são elevados ou limitados pelo `thinkingMap` do modelo escolhido.

## Fontes primárias

- [OpenAI — Practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/):
  começar com agente único; manager pattern quando um coordenador deve manter
  controle e síntese.
- [Anthropic — How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system):
  orchestrator-workers para frentes independentes; objetivo, output, tools,
  fontes e limites explícitos; custo de tokens muito maior e baixo ganho em
  tarefas com contexto/dependências compartilhados.
- [Google Cloud — Choose a design pattern for your agentic AI system](https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system):
  paralelo para subtarefas independentes, sequencial para dependências,
  coordinator para roteamento dinâmico e review/critique para validação.
