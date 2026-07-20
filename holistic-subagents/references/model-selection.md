# Seleção de modelo por tipo de tarefa

Escolha o modelo pela forma da tarefa, não por um papel fixo de subagente.
Esta tabela é a autoridade única para modelo e thinking.

Os perfis abaixo representam observações e preferências locais. Não são
benchmarks nem afirmações universais sobre os modelos.

Como orientação externa, esta divisão segue o guia da Layer3 Labs: Luna para
trabalho bem definido, Terra para produção intermediária e Sol para trabalho
longo, multi-etapas ou que exija maior capacidade. Fonte:
[GPT-5.6 Sol vs Terra vs Luna](https://www.layer3labs.io/guides/gpt-5-6-sol-vs-terra-vs-luna).

O esforço dentro de cada família segue também o
[comparativo do Artificial Analysis](https://artificialanalysis.ai/models?intelligence=coding-index&endpoints=openai_gpt-5-6-sol-high%2Copenai_gpt-5-6-sol-medium%2Copenai_gpt-5-6-sol-low%2Copenai_gpt-5-6-terra-high%2Copenai_gpt-5-6-luna-high%2Copenai_gpt-5-6-terra-medium%2Copenai_gpt-5-6-terra-low%2Copenai_gpt-5-6-luna-medium%2Copenai_gpt-5-6-luna-low&models=).
O Coding Index é a média das avaliações Terminal-Bench v2.1 e SciCode; use-o
como evidência direcional de capacidade de coding, não como medida completa de
qualidade agêntica.

| Tipo de tarefa | Sinais observáveis | Escolha | Coding Index | Tarefas sugeridas | Alternativa permitida | Atenção |
|---|---|---|---:|---|---|---|
| Microtarefa mecânica | rename, spacing, texto, formatação, alteração de uma linha ou comando exato; nenhuma decisão relevante | `openai-codex/gpt-5.6-luna` com `low` | 44,2 | corrigir typo; renomear símbolo já identificado; ajustar lint ou formatação; trocar uma constante; executar comando conhecido | nenhuma | Use somente quando o procedimento e o resultado esperado forem óbvios. |
| Tarefa pequena e explícita | alteração localizada; arquivo conhecido; comportamento esperado explícito; pouca ou nenhuma exploração | `openai-codex/gpt-5.6-luna` com `medium` | 50,7 | adicionar campo simples; atualizar configuração; escrever teste direto; ajustar copy; corrigir bug com causa já conhecida | nenhuma | Se houver contexto implícito, risco de regressão ou investigação, use Luna high. |
| Tarefa pequena e bem definida | poucos arquivos conhecidos; implementação, bug ou review contido; exige raciocínio e validação, mas não exploração ampla | `openai-codex/gpt-5.6-luna` com `high` | 63,3 | implementar componente ou endpoint pequeno; corrigir bug localizado; criar validação de formulário; revisar diff contido; fazer refactor pequeno com testes | `deepseek/deepseek-v4-flash` com `high` | Rota padrão para trabalho pequeno. Se surgirem muitas etapas ou escopo cross-cutting, reclassifique para Terra. |
| Tarefa média e previsível | várias alterações conhecidas; plano claro; coordenação moderada entre arquivos; baixo grau de incerteza | `openai-codex/gpt-5.6-terra` com `low` | 58,1 | propagar mudança de tipo; atualizar vários componentes semelhantes; migrar API interna conhecida; adicionar CRUD convencional; aplicar codemod supervisionado | nenhuma | Luna high tem Coding Index maior neste recorte; prefira Terra low apenas quando a tarefa já tiver forma intermediária, mas execução simples. |
| Tarefa média ou com muitas etapas | implementação, análise ou investigação cotidiana; várias etapas coordenadas; precisa entender contratos e consequências | `openai-codex/gpt-5.6-terra` com `medium` | 64,7 | desenvolver feature ponta a ponta; integrar API; investigar bug entre módulos; refatorar subsistema moderado; criar suíte de testes; analisar documentos ou contratos técnicos | `deepseek/deepseek-v4-pro` com `high` | Rota padrão para trabalho intermediário. |
| Tarefa média difícil ou cross-cutting | exploração ampla; muitos arquivos ou subsistemas; causa incerta; risco ou impacto relevante, mas horizonte ainda limitado | `openai-codex/gpt-5.6-terra` com `high` | depurar falha intermitente; alterar contrato compartilhado; revisar performance; planejar migração moderada; auditar fluxo de autenticação; investigar regressão sem causa conhecida | nenhuma | Se o trabalho também for longo, exigir persistência elevada ou não convergir, use Sol. |
| Tarefa longa e clara | execução prolongada ou refactor multi-arquivo com objetivo, contratos e plano já bem definidos | `openai-codex/gpt-5.6-sol` com `low` | executar migração extensa já planejada; refatorar muitos arquivos por padrão definido; ampliar cobertura de testes do projeto; atualizar framework seguindo roteiro; implementar especificação longa e fechada | nenhuma | Use para obter capacidade e persistência de Sol sem elevar desnecessariamente o esforço. |
| Tarefa longa, complexa ou agêntica | pesquisa profunda, debugging difícil, arquitetura, segurança ou execução autônoma com incerteza relevante | `openai-codex/gpt-5.6-sol` com `medium` | projetar e implementar feature complexa; investigar bug sistêmico; conduzir refactor arquitetural; fazer pesquisa técnica profunda; revisar segurança; coordenar implementação e validação em vários subsistemas | nenhuma | Rota padrão para trabalho longo e de alta exigência. |
| Tarefa crítica ou escalada fundamentada | máxima dificuldade ou impacto; tentativa anterior não convergiu; erro caro; exige a melhor capacidade disponível nesta allowlist | `openai-codex/gpt-5.6-sol` com `high` | diagnosticar incidente crítico; revisar mudança de pagamentos ou segurança; resolver bug após tentativas falhas; decidir arquitetura de alto impacto; planejar migração irreversível; fazer verificação independente de solução crítica | nenhuma | Não escale automaticamente: melhore o brief com a evidência da tentativa anterior. O ganho medido sobre Sol medium é pequeno. |

## Regras

1. Classifique a tarefa antes de escolher modelo.
2. Se a tarefa mudar de forma, classifique novamente pela tabela.
3. Escolha primeiro a família pelo horizonte da tarefa: Luna para pequena,
   Terra para média e Sol para longa ou de maior exigência agêntica.
4. Dentro da família, escolha o menor thinking compatível com dificuldade,
   incerteza, risco e necessidade de autonomia.
5. Não promova uma tarefa somente por diferença pequena no Coding Index; o
   benchmark não mede sozinho duração, custo de coordenação ou persistência.
6. DeepSeek Flash e Pro ocupam faixas equivalentes, mas não possuem qualidade
   necessariamente igual aos modelos principais; use as tarefas sugeridas na
   mesma linha para essas alternativas.
7. Se nenhuma linha representar a tarefa, refine sua descrição antes de delegar.
8. Não faça fallback silencioso para modelos fora da tabela.
9. Consulte [model-commands.md](model-commands.md) somente quando precisar do comando exato.

## Verificar disponibilidade

Faça este preflight uma vez por sessão coordenadora e reutilize o resultado:

```bash
pi --list-models 'gpt-5.6'
pi --list-models 'deepseek-v4'
```
