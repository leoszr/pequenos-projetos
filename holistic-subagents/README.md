# holistic-subagents

Pacote híbrido para Pi: uma skill decide quando e como delegar; uma extensão
TypeScript executa delegações persistentes pelo socket do Herdr.

## Recursos

- lifecycle e event log persistidos na sessão Pi;
- pane, tab e worktree sem foco;
- callbacks autenticados para dúvidas, input obrigatório e handoff;
- conversa e correção na mesma sessão filha;
- policy OpenAI Codex/DeepSeek estruturada;
- auditoria declarativa de autoridade e cleanup por ownership;
- cinco tools `holistic_*` e dashboard `/holistic`.

## Requisitos

- Node.js 22.19+ e Pi 0.79+;
- Herdr com integração Pi current;
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

Local, mantendo vínculo com o checkout:

```bash
pi install .
```

Se uma cópia antiga da skill existir em `~/.pi/agent/skills/holistic-subagents`
ou `~/.agents/skills/holistic-subagents`, mova-a para fora do diretório de
skills. Manter as duas origens causa colisão e pode carregar a documentação
antiga no lugar da skill do pacote.

Também é possível instalar a origem Git/NPM quando publicada. Abra uma nova
sessão Pi após instalar e confirme `pi list` e `herdr integration status`.

## Uso

A skill carrega sob demanda e orienta o agente a usar:

- `holistic_create`;
- `holistic_list`;
- `holistic_inspect`;
- `holistic_send`;
- `holistic_manage`.

O usuário pode abrir `/holistic` para focar, inspecionar, responder, corrigir,
aceitar ou limpar delegações. Sessões filhas não recebem tools coordenadoras e
não podem delegar novamente.

## Segurança

Read-only é uma política instruída e auditada, não sandbox. Para garantia forte
use isolamento externo. Worktrees sujas, branches não preservadas e metadata de
ownership divergente bloqueiam cleanup.

Resultados do último E2E: [TEST_RESULTS.md](TEST_RESULTS.md).
