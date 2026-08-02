# holistic-subagents

Pacote híbrido para Pi: uma skill decide quando e como delegar; uma extensão
TypeScript executa delegações persistentes pelo socket do Herdr.

## Recursos

- lifecycle e event log persistidos na sessão Pi;
- tab principal sempre livre de subagentes;
- panes agrupados em tabs auxiliares, com limite de três panes por tab;
- tab dedicada e worktree sem foco quando a tarefa exige isolamento visual ou de checkout;
- callbacks autenticados para dúvidas, input obrigatório e handoff;
- conversa e correção na mesma sessão filha;
- capacidade semântica e Política de Modelos JSON injetável;
- Luna `xhigh|max` para volume, Terra `xhigh` para execução transversal e Sol
  `low|medium` para alta agência e verification;
- auditoria declarativa de autoridade e cleanup por ownership;
- cinco tools `holistic_*`, dashboard `/holistic` e modo de delegação opt-in.
- Agent Sessions reutilizáveis separadas de Delegation Runs limitadas; reviewer
  warm por padrão e `requiresCleanContext` explícito para contexto limpo.

## Requisitos

- Node.js 22.19+ e Pi 0.79+;
- Herdr 0.7.5+/protocol 17 com integração Pi current;
- Pi iniciado dentro do Herdr (`HERDR_ENV=1`).

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test
python scripts/validate.py
```

Teste o pacote sem instalar:

```bash
pi --extension ./extensions/holistic-subagents.ts \
  --skill ./skills/holistic-subagents
```

## Instalação

Instale a versão publicada no GitHub:

```bash
pi install git:github.com/leoszr/holistic-subagents
```

O Pi usa um clone isolado em `~/.pi/agent/git/`. Alterações no checkout local
não afetam a extensão instalada. Depois de publicar mudanças no GitHub, atualize
explicitamente e recarregue:

```bash
pi update --extension git:github.com/leoszr/holistic-subagents
# dentro do Pi
/reload
```

Para desenvolvimento local sem substituir a instalação persistente:

```bash
pi -e .
```

Se uma cópia antiga da skill existir em `~/.pi/agent/skills/holistic-subagents`
ou `~/.agents/skills/holistic-subagents`, mova-a para fora do diretório de
skills. Manter as duas origens causa colisão e pode carregar a documentação
antiga no lugar da skill do pacote.

Abra uma nova sessão Pi após instalar e confirme `pi list` e
`herdr integration status`.

## Política de modelos

Na primeira sessão coordenadora, a extensão cria a política global editável em:

```text
~/.pi/agent/holistic-subagents/model-policy.json
```

Se `PI_CODING_AGENT_DIR` estiver definido, ele substitui `~/.pi/agent`. Um
projeto confiável pode substituir integralmente a política global com:

```text
.pi/holistic-subagents/model-policy.json
```

Não há merge. Edite o JSON e execute `/reload` ou abra outra sessão. Arquivo
inválido desativa a criação de delegações com erro explícito; modelos ausentes
do registry do Pi geram warning. O arquivo global é criado apenas quando
ausente e nunca é sobrescrito por atualização do pacote.

## Uso

O modo de subagents começa **desligado**. Nesse estado, as tools e a skill de
delegação são retiradas do prompt do pai, em vez de apenas bloquear o spawn.
Ative ou desative com `Ctrl+Shift+S`. O comando abaixo serve como fallback para
terminais que não distinguem `Ctrl+Shift+S` de `Ctrl+S`:

```text
/holistic-mode [on|off|toggle|status]
```

O estado acompanha a sessão Pi. Quando o modo está ativo, a skill carrega sob
demanda e orienta o agente a usar:

- `holistic_create`;
- `holistic_list`;
- `holistic_inspect`;
- `holistic_send`;
- `holistic_manage`.

O usuário pode abrir `/holistic` para focar, inspecionar, responder, corrigir,
aceitar ou limpar delegações, inclusive com o modo desligado. Sessões filhas não
recebem tools coordenadoras e não podem delegar novamente.

## Segurança

Read-only é uma política instruída e auditada, não sandbox. Para garantia forte
use isolamento externo. Worktrees sujas, branches não preservadas e metadata de
ownership divergente bloqueiam cleanup.

Resultados do último E2E: [TEST_RESULTS.md](TEST_RESULTS.md).
