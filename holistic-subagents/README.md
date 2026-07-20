# holistic-subagents

Pacote local de skill para dar ao agente Pi principal liberdade de criar,
supervisionar e conversar com sessões Pi auxiliares persistentes pelo Herdr.

Pode ser carregado diretamente com `--skill` ou instalado globalmente conforme
as instruções abaixo.

## Conteúdo

- `SKILL.md` — decisão autônoma e ciclo de orquestração;
- `references/herdr-operations.md` — comandos de sessão e lifecycle;
- `references/delegation-contract.md` — brief dinâmico, sem papéis fixos;
- `references/model-selection.md` — tabela única de modelo por tipo de tarefa;
- `references/model-commands.md` — comandos exatos, carregados sob demanda;
- `references/worktrees-and-safety.md` — mutação, paralelismo, validação e cleanup.

## Princípios

- delegação opcional e decidida em runtime;
- nenhuma lista fixa de subagentes;
- modelo escolhido por tarefa dentro de uma allowlist local;
- thinking escolhido pela mesma tabela orientada à tarefa;
- sessões interativas e persistentes, não prompts one-shot;
- filho sinaliza bloqueios ao principal com `[HOLISTIC_INPUT_REQUIRED]` e
  encerra o turno para liberar o wait;
- filho sinaliza conclusão ao principal com `[HOLISTIC_HANDOFF_READY]`;
- callback desperta o pai; após dispatch ele encerra o turno em vez de vigiar
  panes, processos ou arquivos;
- espera síncrona é fallback: wait longo orientado a evento e `wait -n` para
  vários filhos; timeout é health check, não polling;
- agente principal continua responsável pelo resultado final.

## Validação local

```bash
python holistic-subagents/scripts/validate.py
```

O script confere frontmatter, links, tabela, comandos, allowlist, flags
obsoletas, integração Herdr e disponibilidade local dos modelos. Não instala a
skill.

Resultados do último teste manual: [TEST_RESULTS.md](TEST_RESULTS.md).

## Testar sem instalar

```bash
pi --skill /home/leo/Projects/pequenos-projetos/holistic-subagents
```

Abra uma nova sessão Pi. Para forçar o carregamento durante um teste:

```text
/skill:holistic-subagents
```

## Instalação global

```bash
mkdir -p ~/.pi/agent/skills
cp -a /home/leo/Projects/pequenos-projetos/holistic-subagents \
  ~/.pi/agent/skills/holistic-subagents
```

Inicie uma nova sessão Pi para atualizar a descoberta de skills.

Valide a cópia instalada:

```bash
python ~/.pi/agent/skills/holistic-subagents/scripts/validate.py
```

Para atualizar a instalação a partir desta fonte:

```bash
cp -a /home/leo/Projects/pequenos-projetos/holistic-subagents/. \
  ~/.pi/agent/skills/holistic-subagents/
```

Depois, execute novamente o validador e abra uma nova sessão Pi.

## Remoção

```bash
rm -rf ~/.pi/agent/skills/holistic-subagents
```

Depois da remoção, inicie outra sessão Pi.
