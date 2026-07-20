# Política de seleção de modelos

A fonte única concreta é `src/models/policy.json`. Ela permite apenas providers
OpenAI Codex e DeepSeek e traduz somente os esforços `low`, `medium` e `high`.
Não mantenha uma tabela paralela de comandos ou modelos neste documento.

## Capacidade pela forma da tarefa

- `bounded`: alteração/investigação localizada, explícita e pouco agêntica;
- `scoped`: missão delimitada com várias etapas e validação observável;
- `cross_cutting`: exploração entre módulos, causa incerta ou decisões
  interdependentes;
- `high_agency`: trabalho amplo, longo, autônomo e com incerteza relevante.

Esses níveis descrevem escopo e agência, não preço, duração isolada, quantidade
de arquivos ou nome de papel.

## Esforço

- `low`: procedimento conhecido, poucas decisões;
- `medium`: padrão multi-etapas;
- `high`: hipóteses concorrentes, risco ou validação difícil.

O resolver traduz o esforço para o nível suportado. A tradução pode elevar um
pedido (por exemplo, alternativa que só oferece high) e registra se não foi
exata.

## Filtros e ordem

1. disponibilidade no `ctx.modelRegistry`;
2. contexto, modalidades, tools e harness obrigatórios;
3. provider/família evitado para independência;
4. menor capacidade igual ou superior à solicitada;
5. preferência local e limites independentes de custo/latência;
6. tradução de thinking.

Se somente candidato de capacidade inferior estiver disponível, a extensão
retorna alternativas degradadas e exige `allowDegraded=true` explícito. Nunca
há fallback fora de OpenAI Codex/DeepSeek.

Para review independente, prefira o outro provider entre os dois quando ele
satisfizer os requisitos. Diversidade reduz correlação, mas não substitui
evidência nem o aceite pelo pai.
