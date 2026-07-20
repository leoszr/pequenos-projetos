# Worktrees e segurança

Carregue esta referência quando houver mutação, paralelismo, risco elevado,
tab/workspace dedicado ou necessidade de cleanup além de um pane comum.

O agente principal continua responsável pela correção final.

## Regras de delegação

- Nunca delegue credenciais, ações destrutivas em produção ou decisões
  irreversíveis sem autorização explícita do usuário.
- Não crie sessões apenas para simular progresso.
- Limite fan-out ao que o agente principal consegue supervisionar e integrar.
- Sessões auxiliares não devem delegar novamente.
- Não presuma que uma sessão recebeu a conversa ou o contexto oculto do pai.
- Não trate confiança ou declaração de conclusão como evidência.

## Escolher a topologia

- pane no checkout atual: trabalho read-only ou mutação única e coordenada;
- tab: trabalho longo que precisa de mais espaço visual;
- worktree: mutações concorrentes ou snapshot estável para validação.

Se uma sessão auxiliar editar o checkout atual, o agente principal deve
congelar suas próprias edições no mesmo checkout até o handoff. Se ambos
precisarem continuar editando, use worktree.

## Criar tab

```bash
herdr tab create \
  --workspace "$HERDR_WORKSPACE_ID" \
  --cwd "$PWD" \
  --env HOLISTIC_SUBAGENT_DEPTH=1 \
  --label "<tarefa>" \
  --no-focus
```

Leia do resultado os IDs criados. Não presuma qual pane pertence à nova tab.

## Criar worktree

```bash
herdr worktree create \
  --cwd "$PWD" \
  --branch "agent/<slug-da-tarefa>" \
  --base "<base-ref>" \
  --label "<tarefa>" \
  --no-focus \
  --json
```

Leia do JSON:

- workspace e root pane;
- caminho do worktree;
- branch criada.

`herdr worktree create` não recebe env arbitrário. Ao iniciar Pi no root pane,
inclua o parent ID diretamente no ambiente do processo:

```bash
HOLISTIC_SUBAGENT_DEPTH=1 \
HOLISTIC_PARENT_PANE_ID="<parent-pane-id>" \
pi <model-thinking-e-name>
```

Não use worktree para pesquisa read-only sem necessidade de snapshot estável ou
build isolado.

## Ownership de mutação

Antes de despachar, defina:

- branch ou commit base;
- arquivos ou subsistema que a sessão pode editar;
- contratos compartilhados somente leitura;
- testes ou evidências esperadas;
- necessidade de commit.

Nunca permita duas sessões editando o mesmo arquivo central ao mesmo tempo,
salvo quando uma delas possuir explicitamente o trabalho de integração.

## Trabalho read-only

Sessões read-only podem compartilhar o checkout quando seus comandos não
alteram Git, arquivos gerados, dependências, portas, bancos ou serviços
compartilhados.

Declare o modo read-only no brief. Para review independente, prefira commit ou
diff estável. Não revise um alvo que muda durante a leitura.

Read-only descreve a intenção, não garante ausência de side effects. Até uma
importação Python pode criar `__pycache__`. Depois da sessão, valide
`git status --short` e remova somente artefatos comprovadamente gerados pelo
teste. Quando conhecido, use controles como `PYTHONDONTWRITEBYTECODE=1`.

## Validação proporcional

Use o menor gate suficiente:

- pesquisa limitada: verificar claims e fontes importantes;
- mudança pequena: inspecionar diff e rodar checks focados;
- implementação normal: inspecionar diff, testes, status e comportamento;
- mudança arriscada: adicionar review independente e validação mais ampla;
- segurança, perda de dados, migrações ou concorrência: exigir evidência
  reproduzível e envolver o usuário quando o impacto for alto.

Review independente é opcional. Quando diversidade importar, considere outro
contexto ou família de modelo, mas compare evidências em vez de confiar apenas
na discordância.

## Evidência de handoff

Para mutações, procure:

- commits ou diff explícito;
- arquivos alterados e justificativa;
- comandos de teste e resultados;
- falhas, checks omitidos e limitações do ambiente;
- estado do worktree;
- riscos de integração.

Para pesquisa, procure paths, símbolos, ranges de linha, fontes primárias,
comandos, logs e incerteza claramente marcada.

Rejeite declarações como “funciona”, “testado” ou “concluído” sem evidência
adequada à tarefa.

## Registro e cleanup

Registre para cada sessão:

- tarefa e nome da sessão;
- pane, tab e workspace IDs;
- cwd ou caminho do worktree;
- branch, quando houver;
- modelo e thinking;
- quais recursos foram criados por este fluxo.

Nunca feche ou remova recursos que não criou.

Antes do cleanup:

1. inspecione Git status;
2. preserve commits, patches, artefatos e logs úteis;
3. confirme integração ou descarte intencional;
4. remova recursos Herdr;
5. remova branches temporárias somente quando seguro;
6. confirme que o checkout principal continua correto.

```bash
git -C <worktree-path> status --short --branch
herdr worktree remove --workspace <workspace-id> --json
```

Use `--force` somente para descarte explícito. Nunca use force cleanup para
esconder trabalho incompleto ou não revisado.
