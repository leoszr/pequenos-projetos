# Pi Memories Extension — Plano de Implementação

## Objetivo
Criar uma extensão simples de memória para o Pi, baseada em Markdown, com foco em melhorar a consistência e qualidade das respostas entre sessões sem aumentar demais o custo de contexto.

## Inspirações
- **Hermes Agent**: `USER.md` + `MEMORY.md`, memória curta, limitada e curada.
- **OpenClaw**: memória em Markdown, camada durável + notas sob demanda.
- **Claude Code**: separação entre instruções persistentes, memória automática e skills.
- **DESIGN.md**: guia visual dedicado para tarefas de UI.

## Princípios
- Markdown como fonte de verdade.
- Memória global tem prioridade maior que memória do projeto.
- Poucos arquivos no MVP.
- Limites rígidos em caracteres.
- Nada de vector DB no início.
- `DESIGN.md` separado de arquitetura e regras de implementação.
- Memória deve ser curada, não um log bruto.

## Estrutura Inicial

### Global
```txt
~/.pi/agent/memory/
  USER.md
  MEMORY.md
```

### Projeto
```txt
<repo>/.pi-memory/
  PROJECT.md      # resumo estável
  DECISIONS.md    # decisões completas
  ACTIVE.md       # estado atual
  DESIGN.md
```

## Limites de Tamanho

A memória sempre carregada deve mirar **~2.000 tokens** e nunca passar de **~2.500 tokens**. O viés é propositalmente maior para a memória global.

### Limites soft/hard — sempre carregados

| Arquivo | Escopo | Soft limit | Hard limit | Uso |
|---|---|---:|---:|---|
| `USER.md` | Global | 1.600 chars (~400 tokens) | 1.800 chars (~450 tokens) | Preferências do usuário, estilo de comunicação, expectativas |
| `MEMORY.md` | Global | 3.600 chars (~900 tokens) | 4.200 chars (~1.050 tokens) | Lições globais, hábitos, ambiente, padrões recorrentes |
| `PROJECT.md` | Projeto | 1.800 chars (~450 tokens) | 2.400 chars (~600 tokens) | Resumo estável: objetivo, arquitetura, stack, comandos e restrições |
| `ACTIVE.md` | Projeto | 1.000 chars (~250 tokens) | 1.600 chars (~400 tokens) | Estado atual, próximos passos, bloqueios e handoff curto |

### Arquivos lazy-loaded — fora do budget fixo

| Arquivo | Escopo | Limite recomendado | Quando carregar |
|---|---|---:|---|
| `DESIGN.md` | Projeto/UI | 4.000 chars (~1.000 tokens) | Apenas tarefas UI/frontend/design |
| `DECISIONS.md` | Projeto | 4.000 chars (~1.000 tokens) | Arquitetura, decisões técnicas, auditoria de tradeoffs |
| `daily/*.md` | Projeto | 3.000 chars por leitura (~750 tokens) | Retomada, histórico recente, investigação |
| `archive.md` | Global/projeto | sem injeção automática | Apenas leitura explícita |

## Budget Estimado

### Turno normal — soft target
Carrega:
- `USER.md`
- `MEMORY.md`
- `PROJECT.md`
- `ACTIVE.md`

Total soft:
- 8.000 chars
- ~2.000 tokens

Distribuição soft:
- Global: 5.200 chars / ~1.300 tokens (~65%)
- Projeto: 2.800 chars / ~700 tokens (~35%)

### Turno normal — hard max
Total hard:
- 10.000 chars
- ~2.500 tokens

Distribuição hard:
- Global: 6.000 chars / ~1.500 tokens (~60%)
- Projeto: 4.000 chars / ~1.000 tokens (~40%)

### Lazy loading
`DESIGN.md`, `DECISIONS.md` e `daily/*.md` são calculados por fora. Eles não entram no teto fixo de 2k–2.5k tokens.

## Conteúdo dos Arquivos

### `USER.md`
Preferências globais do usuário.

Exemplos:
- idioma preferido
- nível de detalhe
- estilo de resposta
- restrições pessoais
- preferências de workflow

### `MEMORY.md`
Memória global do agente.

Exemplos:
- padrões recorrentes entre projetos
- lições aprendidas
- preferências técnicas gerais
- hábitos de implementação
- coisas a evitar em todos os projetos

### `PROJECT.md`
Resumo estável do projeto. Deve ser compacto e não virar log.

Seções recomendadas:
```md
# PROJECT.md

## Purpose

## Architecture

## Commands

## Constraints
```

Deve conter:
- objetivo do projeto
- arquitetura
- comandos essenciais
- restrições importantes

### `DECISIONS.md`
Registro completo das decisões arquiteturais.

Seções recomendadas:
```md
# DECISIONS.md

## YYYY-MM-DD — Título da decisão

Contexto:

Decisão:

Motivo:

Consequências:
```

Deve conter:
- decisões técnicas relevantes
- alternativas consideradas
- motivo da escolha
- impactos futuros

### `ACTIVE.md`
Estado atual do projeto e handoff curto.

Seções recomendadas:
```md
# ACTIVE.md

## Current Stage

## Current Focus

## Next Steps

## Blockers / Open Questions
```

Deve conter:
- estágio atual
- foco da sessão/projeto
- próximos passos
- bloqueios e dúvidas abertas
- contexto temporário útil para retomar trabalho

### `DESIGN.md`
Guia visual do projeto para tarefas de UI.

Seções recomendadas:
```md
# DESIGN.md

## Design Intent

## Visual Personality

## Color Tokens

## Typography

## Spacing

## Layout

## Shape

## Elevation

## Components

## Motion

## Accessibility

## Do / Don't
```

## Comportamento da Extensão

### Ao iniciar sessão
- localizar memória global em `~/.pi/agent/memory/`
- localizar memória do projeto em `.pi-memory/`
- validar limites de tamanho
- preparar snapshot curto para injeção

### Antes de cada prompt
- injetar `USER.md`, `MEMORY.md`, `PROJECT.md` e `ACTIVE.md`
- se a tarefa aparentar ser UI/frontend, também injetar ou instruir leitura de `DESIGN.md`
- se a tarefa envolver arquitetura/decisão técnica, também injetar ou instruir leitura de `DECISIONS.md`
- informar caminhos das memórias carregadas

### Ao escrever memória
- avisar ao passar do soft limit
- rejeitar conteúdo que ultrapasse hard limit
- evitar duplicatas exatas
- preferir substituição/consolidação a append infinito
- não salvar segredos
- se o conteúdo for procedural/repetitivo, sugerir criação de skill em vez de memória factual

## Tools / Comandos MVP

### Tools
- `memory_status`: mostra arquivos, tamanhos e uso de limite
- `memory_write`: adiciona/substitui memória com validação

### Comandos
- `/memory-status`: diagnóstico humano
- `/memory-init`: cria estrutura inicial
- `/memory-review`: revisa memórias sem alterar
- `/memory-clean`: consolida e limpa memórias com cuidado
- `/memory-bootstrap`: roda uma vez, analisa sessões antigas do Pi e popula memória global
- `/memory-skill-candidates`: lista comportamentos repetitivos que podem virar skills

## Skills Futuras

### `review-memory`
Audita sem alterar:
- duplicatas
- contradições
- itens vagos
- excesso de tamanho
- informação no arquivo errado

### `clean-memory`
Altera com segurança:
- consolida duplicatas
- remove ruído
- compacta entradas
- preserva decisões importantes

### `distill-memory`
Futuro:
- extrai aprendizados de sessões/daily logs
- promove só itens duráveis para `MEMORY.md`, `PROJECT.md`, `DECISIONS.md` ou `ACTIVE.md`

### `skill-candidate-review`
Identifica padrões repetitivos que deveriam virar skills:
- tarefas executadas várias vezes com passos parecidos
- correções recorrentes do usuário
- workflows de projeto repetíveis
- comandos ou sequências de inspeção recorrentes
- critérios de verificação que aparecem em múltiplas sessões

Saída esperada:
```md
## Skill Candidates

### Nome sugerido
Trigger:
Procedimento observado:
Evidências/sessões:
Valor esperado:
Risco/observações:
```

### `create-skill-from-candidate`
Transforma candidato aprovado em skill real:
- cria `~/.pi/agent/skills/<skill-name>/SKILL.md` para skill global
- ou `.pi/skills/<skill-name>/SKILL.md` para skill do projeto
- mantém formato Agent Skills: quando usar, procedimento, pitfalls, verificação
- nunca cria skill sem confirmação explícita do usuário

## Bootstrap de Memória Global

### Comando único
```txt
/memory-bootstrap
```

Objetivo: rodar uma vez para analisar todas as sessões já existentes do Pi e popular os arquivos globais:

```txt
~/.pi/agent/memory/USER.md
~/.pi/agent/memory/MEMORY.md
```

### Entradas
- Todas as sessões salvas em `~/.pi/agent/sessions/` ou diretório configurado por `PI_CODING_AGENT_SESSION_DIR`.
- Branches relevantes de cada sessão.
- Mensagens de usuário, respostas, tool results e compactions.

### Processo planejado
1. Localizar sessões existentes.
2. Agrupar por projeto/cwd, data e tamanho.
3. Processar em lotes para evitar contexto gigante.
4. Extrair candidatos globais:
   - preferências explícitas do usuário
   - estilo de resposta desejado
   - ferramentas e workflows recorrentes
   - correções recorrentes ao agente
   - padrões técnicos que aparecem em vários projetos
   - comportamentos que devem ser evitados
5. Separar candidatos em:
   - `USER.md`: preferências pessoais e estilo de trabalho
   - `MEMORY.md`: lições globais, hábitos, padrões recorrentes
   - skill candidates: procedimentos repetitivos
6. Deduplicar e compactar para respeitar soft/hard limits.
7. Gerar relatório de revisão antes de escrever.
8. Pedir confirmação explícita do usuário antes de gravar.

### Regras de segurança
- Não salvar segredos, tokens, chaves, URLs sensíveis ou credenciais.
- Não salvar conteúdo específico de projeto como global, exceto quando aparecer como preferência recorrente entre projetos.
- Não promover uma inferência fraca sem marcar como candidata.
- Preferir “perguntar ao usuário” quando a memória for ambígua.
- Criar backup dos arquivos globais antes de sobrescrever.

### Saídas
```txt
USER.md
MEMORY.md
bootstrap-report.md
skill-candidates.md
```

`bootstrap-report.md` deve conter:
- sessões analisadas
- itens aceitos
- itens descartados
- itens ambíguos
- possíveis skills

`skill-candidates.md` deve conter candidatos que ainda precisam de aprovação para virar skill.

## Criação de Skills a partir da Memória

A extensão deve prever um fluxo para transformar comportamentos repetitivos em skills.

### Quando sugerir skill
Sugerir skill quando o Pi identificar:
- mesmo procedimento em 2+ sessões
- correção do usuário repetida
- checklist operacional reutilizável
- workflow com passos verificáveis
- comportamento que melhora qualidade se carregado sob demanda

### O que não vira skill
- preferência simples: fica em `USER.md`
- fato global curto: fica em `MEMORY.md`
- decisão de projeto: fica em `DECISIONS.md`
- estado temporário: fica em `ACTIVE.md`

### Estrutura de skill sugerida
```txt
~/.pi/agent/skills/<skill-name>/
  SKILL.md
```

Template:
```md
# <Skill Name>
Use this skill when ...

## Procedure
1. ...
2. ...

## Pitfalls
- ...

## Verification
- ...
```

## Fora do MVP
- busca semântica / qmd
- vector DB
- daily logs automáticos
- auto-learning após toda tarefa
- scoring/recência/frequência
- auto-commit git

## Evolução Planejada

### MVP
- arquivos globais + projeto
- soft/hard limits por chars
- injeção controlada com alvo ~2k tokens e hard max ~2.5k tokens
- status e init
- bootstrap manual único para memória global
- geração de relatório de candidatos a skills

### V2
- skills de revisão/limpeza
- criação assistida de skills a partir de candidatos aprovados
- daily logs opcionais

### V3
- busca local
- qmd opcional
- distilação periódica
- integração com compaction

## Critério de Sucesso
A extensão melhora o output do Pi se:
- reduz repetição de preferências já ditas
- mantém decisões arquiteturais consistentes
- ajuda o agente a entender estágio atual do projeto
- melhora UI gerada quando `DESIGN.md` existe
- adiciona ~2k tokens em turnos normais, com hard max ~2.5k tokens
